/**
 * Repair half-baked tool-call parts left over from an aborted turn.
 *
 * Background — chats `236a4117` and `feca41d8` both hit the same
 * shape: the model emitted a `tool-codemode` (or other tool) call,
 * persisted with `state: "input-available"`, and the turn was aborted
 * (WS drop, network flap, tab close) before the sandbox finished. The
 * tool part stays in the message history forever as an
 * `input-available` part with no result. On the next user turn the
 * AI SDK / Workers AI rejects the message prefix because it contains
 * a `tool_use` block with no matching `tool_result`, and the user
 * sees the generic "Something went wrong" banner.
 *
 * The recovery (`debugClearMessages`) wipes the entire history, which
 * is heavy-handed and loses context. Instead we sweep dangling tool
 * parts on every `beforeTurn` and replace each one with a synthetic
 * `output-error` part shaped exactly like our `wrapCodemodeTool`
 * envelope. The model sees a recoverable error in its history and
 * naturally adapts (e.g. retries the `db.introspect` call) on the
 * next turn.
 *
 * This file is intentionally pure (no DO, no env, no SDK references)
 * so it can be unit-tested in isolation. The integration point is in
 * `agent.ts:beforeTurn`, which calls `saveMessages` with a callback
 * derived from `repairDanglingToolParts`.
 */

/**
 * AI-SDK `UIMessage` tool-part state machine
 * (from `node_modules/ai/dist/index.d.ts`):
 *
 *   input-streaming
 *     → input-available
 *         → approval-requested → approval-responded
 *         → output-available  (success)
 *         → output-error      (sandbox / model error)
 *         → output-denied
 *
 * Anything that is *not* a terminal state (`output-available`,
 * `output-error`, `output-denied`) is "dangling" if it appears in
 * persisted history at the start of a fresh turn.
 */
const TERMINAL_STATES: ReadonlySet<string> = new Set([
  "output-available",
  "output-error",
  "output-denied",
]);

/** Loose shape — we only ever inspect `state`, `type`, and a couple of
 *  identifying fields. Avoids importing from the AI SDK so this stays
 *  test-friendly. */
type ToolPart = {
  type: string;
  state?: string;
  toolName?: string;
  toolCallId?: string;
  input?: unknown;
};

type AnyPart = { type?: string; [k: string]: unknown };
type AnyMessage = { role?: string; parts?: AnyPart[]; [k: string]: unknown };

/**
 * A part is a tool part if its `type` is `"tool-<name>"` or
 * `"dynamic-tool"`. The codemode wrapper stamps `tool-codemode` for
 * the wrapped tool and the literal name for dynamic tools.
 */
function isToolPart(part: AnyPart): part is ToolPart & AnyPart {
  if (typeof part.type !== "string") return false;
  return part.type === "dynamic-tool" || part.type.startsWith("tool-");
}

/**
 * Did this tool part finish? A part with no `state` field at all is
 * treated as terminal (defensive — older message rows may predate
 * the state machine).
 */
function isTerminal(part: ToolPart): boolean {
  if (part.state === undefined) return true;
  return TERMINAL_STATES.has(part.state);
}

/**
 * Build the synthetic `output-error` envelope that replaces the
 * dangling part. The shape mirrors AI SDK's `output-error` tool-part
 * variant so the AI SDK serializes it back into a `tool_result` block
 * with the error string when constructing the next request.
 *
 * `errorText` is the string the model will see in its context. We
 * mark it `recoverable: true` and keep the language consistent with
 * `wrapCodemodeTool` so the LLM treats it as a retryable failure
 * rather than a hard stop.
 */
function buildErrorPart(part: ToolPart): AnyPart {
  const errorText = JSON.stringify({
    error: "tool_call_interrupted",
    message:
      "Tool call was interrupted before it produced a result " +
      "(likely a network/tab disconnect). The call did not complete; " +
      "retry from a fresh state if you still need the answer.",
    recoverable: true,
  });
  // Spread the original part so we preserve `type`, `toolName`,
  // `toolCallId`, `input`, etc. — the AI SDK uses `toolCallId` to
  // pair tool_use with tool_result, and dropping it would orphan
  // the synthesis.
  return {
    ...(part as AnyPart),
    state: "output-error",
    output: undefined,
    errorText,
  };
}

export type RepairResult = {
  /** New message array. Reference-equal to the input when nothing
   *  needed repair (so the caller can short-circuit `saveMessages`). */
  messages: AnyMessage[];
  /** How many tool parts were rewritten across the history. */
  repaired: number;
  /** Optional per-occurrence detail for logging. */
  details: Array<{
    messageIndex: number;
    partIndex: number;
    toolName?: string;
    toolCallId?: string;
    previousState?: string;
  }>;
};

/**
 * Walk every assistant message and replace any non-terminal tool
 * part with a synthetic error result. Returns the original array
 * reference unchanged if nothing was found, so the caller can avoid
 * a no-op `saveMessages` write.
 *
 * We only repair `role: "assistant"` messages — tool parts on user
 * messages (rare, but possible if a future feature attaches them)
 * are left alone because they can't be tool_use blocks the model
 * emitted.
 */
export function repairDanglingToolParts(messages: AnyMessage[]): RepairResult {
  let repaired = 0;
  const details: RepairResult["details"] = [];

  // First pass: detect. Avoids allocating a copy when the history is
  // already clean (the steady-state case on every turn after the
  // first one in a healthy chat).
  let dirty = false;
  outer: for (const m of messages) {
    if (m.role !== "assistant" || !Array.isArray(m.parts)) continue;
    for (const p of m.parts) {
      if (isToolPart(p) && !isTerminal(p)) {
        dirty = true;
        break outer;
      }
    }
  }
  if (!dirty) {
    return { messages, repaired: 0, details };
  }

  // Second pass: rewrite. Shallow-copy the affected message + its
  // parts array; leave clean messages untouched (reference-equal) so
  // upstream identity checks don't churn unnecessarily.
  const next = messages.map((m, mi) => {
    if (m.role !== "assistant" || !Array.isArray(m.parts)) return m;
    let messageDirty = false;
    const nextParts = m.parts.map((p, pi) => {
      if (!isToolPart(p)) return p;
      if (isTerminal(p)) return p;
      messageDirty = true;
      repaired++;
      details.push({
        messageIndex: mi,
        partIndex: pi,
        toolName: p.toolName,
        toolCallId: p.toolCallId,
        previousState: p.state,
      });
      return buildErrorPart(p);
    });
    return messageDirty ? { ...m, parts: nextParts } : m;
  });

  return { messages: next, repaired, details };
}
