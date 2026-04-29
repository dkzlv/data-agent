/**
 * Post-turn fact extractor (task a0e754).
 *
 * `memory.remember` covers explicit saves the model proactively
 * makes during a turn. This extractor covers the *implicit* case:
 * the user thanks the agent for a query, the agent answers a
 * schema-clarification question, the user corrects an entity name —
 * none of that triggers a `remember` call, but all of it is
 * durable knowledge that should generalize to future chats.
 *
 * Strategy (mirrors mem0's "extract → dedupe → embed" pipeline but
 * in-house and Workers-native):
 *
 *   1. After every successful turn (status="completed"), build a
 *      compact transcript of just *this* turn — last user message,
 *      tool-call outcomes (success vs error + names), assistant
 *      final text. Cap at ~2k tokens.
 *
 *   2. Call Workers AI llama-3.1-8b with a tight extraction prompt:
 *        "extract 0-3 durable facts ... return JSON {facts:[...]}".
 *      `enable_thinking: false` + `maxOutputTokens: 512` so the
 *      model spends its budget on output, not reasoning.
 *
 *   3. Parse JSON; for each fact, run the same dedupe+insert path
 *      `memory.remember` uses (`persistFact` + embed + Vectorize).
 *      Dedupe on (dbProfileId, contentHash) means re-extracting
 *      the same fact across many turns collapses to one row.
 *
 *   4. Per-tenant rate cap (5 facts/hour) prevents a model that
 *      loves to remember things from spamming the index.
 *
 * Failure modes (all silent — extraction is best-effort):
 *   - Model returns garbage / non-JSON → zero facts, warn log.
 *   - Vectorize / embed fails on one fact → skip that fact, keep
 *     the rest.
 *   - Rate cap hit → skip extraction entirely, info log.
 *
 * Fired from `onChatResponse` via `ctx.waitUntil` so the user sees
 * the assistant reply immediately; extraction completes in the
 * background.
 */
import { generateText } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import {
  isMemoryKind,
  logEvent,
  truncateMessage,
  validateMemoryContent,
  type MemoryKind,
} from "@data-agent/shared";
import type { Env } from "../env";
import { embedText } from "./embed";
import { persistFact } from "./store";
import { upsertVector } from "./vectorize";

/** Cheap, deterministic, decoupled from chat-model swaps. Same
 *  reasoning as the title summarizer override (subtask 16656a). */
const EXTRACT_MODEL = "@cf/meta/llama-3.1-8b-instruct" as const;

/** Per-tenant cap. Soft: counted via the `memory.extract_run` audit
 *  rows in the past hour. Hot path doesn't query Postgres for the
 *  count — instead the agent tracks a per-DO sliding window. */
export const EXTRACT_FACTS_PER_HOUR_PER_TENANT = 5;

/** Max input transcript size handed to the extractor model. Keeps
 *  cost predictable; longer transcripts produce diminishing returns. */
const MAX_TRANSCRIPT_CHARS = 8_000;

/**
 * Inputs for `extractAndPersist`. Shape mirrors what the agent has
 * after a turn completes: full message history, the dbProfile/tenant
 * envelope, and a way to schedule waitUntil-style background work.
 */
export interface ExtractInputs {
  env: Env;
  tenantId: string;
  dbProfileId: string;
  chatId: string;
  turnId: string | null;
  /** UIMessage list as the Think framework persisted it. We walk it
   *  to find this turn's user message + assistant response. */
  messages: unknown[];
  userId: string | null;
  gatewayId: string | null;
}

/** Per-fact result for diagnostics + audit payload. */
export interface ExtractedRecord {
  kind: MemoryKind;
  content: string;
  factId?: string;
  inserted: boolean;
  error?: string;
}

/**
 * System prompt for extraction. Locked into a string constant so a
 * test pins the literal — small wording changes here change recall
 * quality across the whole product.
 *
 * Design notes:
 *   - Asks for 0-3 facts so the model isn't pressured to find
 *     something even when nothing's worth saving.
 *   - Lists the kind vocabulary — same as the `memoryKind` enum —
 *     so the model maps to one of our buckets (we reject unknown
 *     kinds at validation time).
 *   - Negative examples: "don't extract one-off requests / don't
 *     extract things the user didn't actually say".
 *   - JSON-only output. Minor JSON-parse failures will fall through
 *     to "extracted 0 facts" rather than crash anything.
 */
export const EXTRACT_SYSTEM_PROMPT = `You read a single conversation turn between a user and a data analyst AI working on a Postgres database, and decide whether ANYTHING durable was learned that should be remembered for future conversations about THIS DATABASE.

Most turns produce nothing worth saving. Default to extracting 0 facts. Only extract a fact when:
  - the user explicitly stated a business definition, schema meaning, or preference, OR
  - the agent discovered a non-obvious column meaning, table relationship, or working query pattern that will generalize, OR
  - an entity-id mapping was established ("Acme = customer 1234").

Each fact must:
  - be 10-500 chars, plain English, self-contained (someone reading it cold should understand it)
  - generalize beyond this specific turn (NOT "the user wants top-10 customers right now")
  - NOT restate something the user could re-derive from \`db.introspect()\`

Output ONLY a JSON object of this exact shape, no prose, no markdown fences:

{"facts": [
  {"kind": "schema_semantic" | "business_def" | "user_pref" | "query_pattern_good" | "query_pattern_bad" | "entity", "content": "..."}
]}

If nothing's worth saving, output {"facts": []}. Maximum 3 facts.`;

/** Stable wire shape for parsed extraction output. Exported for tests. */
export interface ExtractOutput {
  facts: Array<{ kind: MemoryKind; content: string }>;
}

/**
 * Build a compact transcript of a single turn. We can't trust the
 * structure of `parts[]` exactly (UIMessage shapes drift across SDK
 * versions), so we duck-type and fall back to ignoring unrecognized
 * parts.
 *
 * Pure function — exported for unit tests.
 */
export function buildTurnTranscript(messages: unknown[]): string {
  if (!Array.isArray(messages) || messages.length === 0) return "";

  // Find the boundary of "this turn": the *last* user message + every
  // message after it. We treat earlier history as already-extracted.
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string };
    if (m?.role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx < 0) return "";
  const slice = messages.slice(lastUserIdx);

  const lines: string[] = [];
  for (const msg of slice) {
    const m = msg as { role?: string; parts?: unknown };
    const role = m.role === "user" ? "User" : m.role === "assistant" ? "Assistant" : null;
    if (!role) continue;
    if (!Array.isArray(m.parts)) continue;

    for (const part of m.parts) {
      if (!part || typeof part !== "object") continue;
      const p = part as { type?: string; text?: string; toolName?: string; output?: unknown };
      if (p.type === "text" && typeof p.text === "string") {
        lines.push(`${role}: ${p.text}`);
      } else if (typeof p.type === "string" && p.type.startsWith("tool-")) {
        // Codemode tool call. We don't include the `code` (too noisy
        // for an 8k-token extractor) — just the tool name + a short
        // outcome. The transcript doesn't need to reconstruct the
        // SQL; the extractor is reasoning over *what was learned*,
        // not *what was run*.
        const toolName = p.toolName ?? p.type.replace(/^tool-/, "");
        const outputSummary =
          p.output && typeof p.output === "object"
            ? JSON.stringify(p.output).slice(0, 280)
            : "(executed)";
        lines.push(`${role} [tool=${toolName}]: ${outputSummary}`);
      }
    }
  }
  const joined = lines.join("\n");
  return joined.length > MAX_TRANSCRIPT_CHARS ? joined.slice(0, MAX_TRANSCRIPT_CHARS) : joined;
}

/**
 * Parse the extractor's raw output. Tolerates light Markdown fences
 * (```json...```) the model sometimes adds despite instructions.
 * Returns an empty `facts` list on any parse error.
 *
 * Pure function — exported for tests.
 */
export function parseExtractOutput(raw: string | null | undefined): ExtractOutput {
  if (!raw) return { facts: [] };
  // Strip surrounding code fences if present.
  const stripped = raw
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return { facts: [] };
  }
  if (!parsed || typeof parsed !== "object") return { facts: [] };
  const facts = (parsed as { facts?: unknown }).facts;
  if (!Array.isArray(facts)) return { facts: [] };
  const out: ExtractOutput["facts"] = [];
  for (const f of facts) {
    if (!f || typeof f !== "object") continue;
    const obj = f as { kind?: unknown; content?: unknown };
    if (!isMemoryKind(obj.kind)) continue;
    if (obj.kind === "chat_summary") continue; // reserved for system
    if (typeof obj.content !== "string") continue;
    const v = validateMemoryContent(obj.content);
    if (!v.ok) continue;
    out.push({ kind: obj.kind, content: v.display });
    if (out.length >= 3) break;
  }
  return { facts: out };
}

/**
 * End-to-end: build transcript → call extractor → parse → persist.
 * All errors caught + logged; never throws. Fire-and-forget from
 * `onChatResponse` via `ctx.waitUntil`.
 *
 * `quotaCheck` is the per-tenant rate gate. Caller (the agent)
 * holds the sliding window in DO memory; we ask it whether we have
 * room before spending on the model call.
 */
export async function extractAndPersist(
  inputs: ExtractInputs,
  quotaCheck: () => { ok: boolean; remaining: number }
): Promise<{ extracted: number; records: ExtractedRecord[] }> {
  const startedAt = Date.now();
  const transcript = buildTurnTranscript(inputs.messages);
  if (!transcript || transcript.length < 60) {
    // Tiny transcript — skip without a model call. Avoids spending
    // tokens on "yes" / "no" exchanges that produce no fact.
    logEvent({
      event: "memory.extract_skipped",
      level: "debug",
      reason: "transcript_too_short",
      transcriptChars: transcript.length,
      chatId: inputs.chatId,
      tenantId: inputs.tenantId,
      turnId: inputs.turnId,
    });
    return { extracted: 0, records: [] };
  }

  const quota = quotaCheck();
  if (!quota.ok) {
    logEvent({
      event: "memory.extract_skipped",
      level: "info",
      reason: "rate_capped",
      remaining: quota.remaining,
      chatId: inputs.chatId,
      tenantId: inputs.tenantId,
    });
    return { extracted: 0, records: [] };
  }

  logEvent({
    event: "memory.extract_start",
    level: "info",
    chatId: inputs.chatId,
    tenantId: inputs.tenantId,
    turnId: inputs.turnId,
    model: EXTRACT_MODEL,
    transcriptChars: transcript.length,
  });

  let parsed: ExtractOutput = { facts: [] };
  try {
    const workersai = createWorkersAI({ binding: inputs.env.AI });
    const gateway = inputs.gatewayId
      ? {
          id: inputs.gatewayId,
          metadata: {
            tenantId: inputs.tenantId,
            chatId: inputs.chatId,
            userId: inputs.userId ?? "unknown",
            model: EXTRACT_MODEL,
            // Bucket extraction calls separately from chat + title
            // in the gateway dashboard.
            kind: "memory-extract",
          },
        }
      : undefined;
    const model = workersai(EXTRACT_MODEL, gateway ? { gateway } : {});
    const result = await generateText({
      model,
      system: EXTRACT_SYSTEM_PROMPT,
      prompt: transcript,
      temperature: 0.2,
      maxOutputTokens: 512,
    });
    parsed = parseExtractOutput(result.text);
  } catch (err) {
    logEvent({
      event: "memory.extract_failed",
      level: "warn",
      chatId: inputs.chatId,
      tenantId: inputs.tenantId,
      turnId: inputs.turnId,
      reason: "model_call_failed",
      error: truncateMessage(err),
      durationMs: Date.now() - startedAt,
    });
    return { extracted: 0, records: [] };
  }

  if (parsed.facts.length === 0) {
    logEvent({
      event: "memory.extract_complete",
      level: "info",
      extracted: 0,
      chatId: inputs.chatId,
      tenantId: inputs.tenantId,
      turnId: inputs.turnId,
      durationMs: Date.now() - startedAt,
    });
    return { extracted: 0, records: [] };
  }

  // Persist each fact, embed iff it was newly inserted, upsert into
  // Vectorize. Per-fact errors are logged but don't abort the others.
  const records: ExtractedRecord[] = [];
  for (const fact of parsed.facts) {
    try {
      const result = await persistFact(inputs.env, {
        tenantId: inputs.tenantId,
        dbProfileId: inputs.dbProfileId,
        kind: fact.kind,
        content: fact.content,
        // No createdBy attribution: the extractor isn't a user, and
        // the api-gateway's REST surface treats null `createdBy` as
        // "system-extracted" in the UI.
        sourceChatId: inputs.chatId,
        sourceTurnId: inputs.turnId,
        createdBy: null,
      });
      if (!result.ok) {
        records.push({
          kind: fact.kind,
          content: fact.content,
          inserted: false,
          error: `cap_reached:${result.cap}`,
        });
        continue;
      }
      // Only embed when the row is new — same logic as the explicit
      // tool path. A re-extraction of an existing fact just bumps
      // updatedAt.
      if (result.inserted || result.revivedFromSoftDelete) {
        try {
          const vec = await embedText(inputs.env, fact.content);
          await upsertVector(inputs.env, {
            id: result.row.id,
            values: vec,
            tenantId: inputs.tenantId,
            metadata: {
              dbProfileId: inputs.dbProfileId,
              kind: fact.kind,
              createdAt: result.row.createdAt.toISOString(),
            },
          });
        } catch (err) {
          // Embed failure: persistFact already inserted the row.
          // Drop the row so Postgres + Vectorize stay aligned. The
          // dedupe will rescue this on a future extraction if the
          // model re-derives the same fact later.
          // (We don't have a softDelete here without an extra round-
          // trip; persistFact's "revive on next save" path handles it.)
          logEvent({
            event: "memory.extract_failed",
            level: "warn",
            reason: "embed_or_upsert_failed",
            factId: result.row.id,
            error: truncateMessage(err),
          });
          records.push({
            kind: fact.kind,
            content: fact.content,
            factId: result.row.id,
            inserted: false,
            error: "embed_failed",
          });
          continue;
        }
      }
      records.push({
        kind: fact.kind,
        content: fact.content,
        factId: result.row.id,
        inserted: result.inserted,
      });
    } catch (err) {
      logEvent({
        event: "memory.extract_failed",
        level: "warn",
        reason: "persist_failed",
        kind: fact.kind,
        error: truncateMessage(err),
      });
      records.push({
        kind: fact.kind,
        content: fact.content,
        inserted: false,
        error: "persist_failed",
      });
    }
  }

  const insertedCount = records.filter((r) => r.inserted).length;
  logEvent({
    event: "memory.extract_complete",
    level: "info",
    chatId: inputs.chatId,
    tenantId: inputs.tenantId,
    turnId: inputs.turnId,
    extracted: insertedCount,
    proposed: parsed.facts.length,
    durationMs: Date.now() - startedAt,
  });

  return { extracted: insertedCount, records };
}
