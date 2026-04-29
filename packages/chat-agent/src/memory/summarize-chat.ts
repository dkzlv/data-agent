/**
 * Periodic chat-summary fact (task a0e754).
 *
 * After every N turns we condense the chat-so-far into a one-
 * paragraph summary and persist it as a `chat_summary` fact. This
 * is the *only* path that creates `chat_summary` facts — the
 * explicit `memory.remember` tool rejects the kind, and the
 * extractor's prompt doesn't list it.
 *
 * Why one-paragraph instead of full transcript:
 *   - Transcripts are huge; cross-chat recall doesn't need a play-
 *     by-play. A summary is what survives when you move the chat
 *     into "background context" for future chats.
 *   - bge-base-en embeds short summaries much better than 50-turn
 *     transcripts (the embedding gets averaged toward generic).
 *
 * Idempotency: one summary per chat, updated in place. The dedupe
 * key is the *chat id* (not contentHash) — we'd want one row per
 * chat, refreshed as new turns happen, not a new row each time.
 *
 * Trigger: every 10 turns (counted by user-message count). Fired
 * from the agent's `onChatResponse` via `waitUntil`. The "every 10"
 * cadence is fast enough that an active chat keeps its summary
 * fresh without a per-turn write.
 */
import { generateText } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { and, eq } from "drizzle-orm";
import { createDbClient, schema } from "@data-agent/db";
import { logEvent, truncateMessage, validateMemoryContent } from "@data-agent/shared";
import { readSecret, type Env } from "../env";
import { embedText } from "./embed";
import { upsertVector } from "./vectorize";

/** Same lightweight model as `extract.ts`. */
const SUMMARY_MODEL = "@cf/meta/llama-3.1-8b-instruct" as const;

/** Run a summary every N user messages. Picked so an active chat
 *  refreshes a few times a day; idle chats stay stable. */
export const SUMMARY_TRIGGER_EVERY = 10;

/** Hard cap on the input transcript. Same reasoning as in
 *  `extract.ts` — long transcripts produce diminishing returns and
 *  inflate cost. */
const MAX_TRANSCRIPT_CHARS = 16_000;

/**
 * System prompt for the summarizer. Tight one-paragraph constraint
 * so the result fits the recalled-facts block without crowding out
 * other facts.
 *
 * Constraints in the prompt:
 *   - "What was investigated, key findings, open questions" — the
 *     three pieces a future chat would want as context.
 *   - "One paragraph" + "≤ 80 words" so the embedding doesn't get
 *     averaged into something generic.
 *   - "Do NOT include personal opinions or speculation" — we don't
 *     want the model to invent context.
 */
export const SUMMARY_SYSTEM_PROMPT = `Summarize the following conversation in ONE concise paragraph (≤ 80 words). Cover: what was investigated, the key findings (with concrete numbers/names where they appeared), and any open questions. Plain prose; no bullets, no markdown, no preamble. Do NOT speculate beyond what's in the transcript.`;

export interface SummarizeChatInputs {
  env: Env;
  tenantId: string;
  dbProfileId: string;
  chatId: string;
  /** UIMessage list. */
  messages: unknown[];
  gatewayId: string | null;
  /** Optional. Stamped on the audit row. */
  userId: string | null;
}

/**
 * Walk all `text` parts across every persisted message into a
 * single transcript. Pure function — exported for tests.
 *
 * Tool calls are summarized as `(tool: name)` markers so the model
 * has *some* signal that work happened, without ballooning the
 * input.
 */
export function buildFullTranscript(messages: unknown[]): string {
  if (!Array.isArray(messages)) return "";
  const lines: string[] = [];
  for (const msg of messages) {
    const m = msg as { role?: string; parts?: unknown };
    const role = m.role === "user" ? "User" : m.role === "assistant" ? "Assistant" : null;
    if (!role || !Array.isArray(m.parts)) continue;
    for (const part of m.parts) {
      if (!part || typeof part !== "object") continue;
      const p = part as { type?: string; text?: string; toolName?: string };
      if (p.type === "text" && typeof p.text === "string") {
        lines.push(`${role}: ${p.text}`);
      } else if (typeof p.type === "string" && p.type.startsWith("tool-")) {
        const name = p.toolName ?? p.type.replace(/^tool-/, "");
        lines.push(`${role} (tool: ${name})`);
      }
    }
  }
  const joined = lines.join("\n");
  return joined.length > MAX_TRANSCRIPT_CHARS ? joined.slice(0, MAX_TRANSCRIPT_CHARS) : joined;
}

/**
 * Count user messages in the persisted history. Used by the agent
 * as the trigger gate — every `SUMMARY_TRIGGER_EVERY` user messages,
 * we re-summarize. Pure function, exported for tests.
 */
export function countUserMessages(messages: unknown[]): number {
  if (!Array.isArray(messages)) return 0;
  let n = 0;
  for (const m of messages) {
    if ((m as { role?: string }).role === "user") n++;
  }
  return n;
}

/**
 * One summary per chat — keyed off `payload.chatId` rather than
 * `contentHash`. We hand-write the SQL for upsert-by-chatId because
 * Drizzle's `onConflict` is keyed on indexes/constraints; we don't
 * want to add a unique index on `(payload->>'chatId')` just for
 * this. Two-step (find → update or insert) is fine — summaries are
 * infrequent.
 */
export async function summarizeAndPersistChat(inputs: SummarizeChatInputs): Promise<void> {
  const startedAt = Date.now();
  const transcript = buildFullTranscript(inputs.messages);
  if (!transcript || transcript.length < 200) {
    logEvent({
      event: "memory.summary_skipped",
      level: "debug",
      reason: "transcript_too_short",
      chatId: inputs.chatId,
      tenantId: inputs.tenantId,
    });
    return;
  }

  let summary: string | null = null;
  try {
    const workersai = createWorkersAI({ binding: inputs.env.AI });
    const gateway = inputs.gatewayId
      ? {
          id: inputs.gatewayId,
          metadata: {
            tenantId: inputs.tenantId,
            chatId: inputs.chatId,
            model: SUMMARY_MODEL,
            kind: "memory-summary",
          },
        }
      : undefined;
    const model = workersai(SUMMARY_MODEL, gateway ? { gateway } : {});
    const result = await generateText({
      model,
      system: SUMMARY_SYSTEM_PROMPT,
      prompt: transcript,
      temperature: 0.3,
      maxOutputTokens: 256,
    });
    summary = result.text?.trim() ?? null;
  } catch (err) {
    logEvent({
      event: "memory.summary_failed",
      level: "warn",
      reason: "model_call_failed",
      error: truncateMessage(err),
      chatId: inputs.chatId,
      tenantId: inputs.tenantId,
    });
    return;
  }

  // Validation — same caps as `memory.remember`. If the model
  // returned a paragraph longer than 500 chars, we truncate at the
  // last sentence boundary rather than dropping it; chat summaries
  // are wider in scope than user-saved facts and the validator's
  // strict 500 cap is a UX heuristic, not a hard limit.
  if (!summary) {
    logEvent({
      event: "memory.summary_failed",
      level: "warn",
      reason: "empty_output",
      chatId: inputs.chatId,
      tenantId: inputs.tenantId,
    });
    return;
  }
  let content = summary;
  if (content.length > 500) {
    const cut = content.slice(0, 500);
    const lastPeriod = Math.max(
      cut.lastIndexOf(". "),
      cut.lastIndexOf("! "),
      cut.lastIndexOf("? ")
    );
    content = lastPeriod > 200 ? cut.slice(0, lastPeriod + 1) : cut;
  }
  const validated = validateMemoryContent(content);
  if (!validated.ok) {
    logEvent({
      event: "memory.summary_failed",
      level: "warn",
      reason: `validation:${validated.reason}`,
      chatId: inputs.chatId,
      tenantId: inputs.tenantId,
    });
    return;
  }

  const url = await readSecret(inputs.env.CONTROL_PLANE_DB_URL);
  const { db, client } = createDbClient({ url, max: 1 });
  let factId: string | null = null;
  let inserted = false;
  try {
    // Look for an existing summary for THIS chat — payload.chatId
    // match. Drizzle has a JSON ops helper but we just hand-write
    // it for clarity.
    const [existing] = await db
      .select()
      .from(schema.memoryFact)
      .where(
        and(
          eq(schema.memoryFact.dbProfileId, inputs.dbProfileId),
          eq(schema.memoryFact.tenantId, inputs.tenantId),
          eq(schema.memoryFact.kind, "chat_summary"),
          eq(schema.memoryFact.sourceChatId, inputs.chatId)
        )
      )
      .limit(1);

    const { hashContent: hashFn } = await import("@data-agent/shared");
    const newHash = await hashFn(validated.normalized);

    if (existing) {
      // Update in place. Don't change `createdAt`.
      const [updated] = await db
        .update(schema.memoryFact)
        .set({
          content: validated.display,
          contentHash: newHash,
          updatedAt: new Date(),
          deletedAt: null, // revive if previously soft-deleted
          payload: { lastSummaryAt: new Date().toISOString() },
        })
        .where(eq(schema.memoryFact.id, existing.id))
        .returning();
      factId = updated?.id ?? null;
    } else {
      const [row] = await db
        .insert(schema.memoryFact)
        .values({
          tenantId: inputs.tenantId,
          dbProfileId: inputs.dbProfileId,
          kind: "chat_summary",
          content: validated.display,
          contentHash: newHash,
          payload: { lastSummaryAt: new Date().toISOString() },
          sourceChatId: inputs.chatId,
          createdBy: null,
        })
        .returning();
      factId = row?.id ?? null;
      inserted = true;
    }
  } catch (err) {
    logEvent({
      event: "memory.summary_failed",
      level: "warn",
      reason: "persist_failed",
      error: truncateMessage(err),
      chatId: inputs.chatId,
      tenantId: inputs.tenantId,
    });
    await client.end({ timeout: 1 }).catch(() => {});
    return;
  }
  await client.end({ timeout: 1 }).catch(() => {});

  if (!factId) return;

  // Re-embed on every summary refresh — content has changed, so
  // the existing vector is stale. Failure here is non-fatal; the
  // recall path will degrade gracefully.
  try {
    const vec = await embedText(inputs.env, validated.display);
    await upsertVector(inputs.env, {
      id: factId,
      values: vec,
      tenantId: inputs.tenantId,
      metadata: {
        dbProfileId: inputs.dbProfileId,
        kind: "chat_summary",
        createdAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    logEvent({
      event: "memory.summary_failed",
      level: "warn",
      reason: "embed_or_upsert_failed",
      factId,
      error: truncateMessage(err),
    });
    // Don't roll back — a stale vector with fresh content is still
    // better than nothing for recall, and the next summary refresh
    // will retry the embed.
  }

  logEvent({
    event: "memory.summary_persisted",
    level: "info",
    chatId: inputs.chatId,
    tenantId: inputs.tenantId,
    factId,
    inserted,
    durationMs: Date.now() - startedAt,
    summaryChars: validated.display.length,
  });
}
