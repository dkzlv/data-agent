/**
 * Small observability helpers — pulled out of agent.ts so they're
 * unit-testable and shareable with future agents.
 */

/**
 * Count active WS connections to an agents-SDK Agent. Used in
 * observability spans so we can correlate "WS dropped" events with
 * "turn aborted" (subtask 9fa055 streaming-debug).
 *
 * Uses a duck-typed cast because `agents`'s base class exposes
 * `getConnections()` typed for state-narrowing — we just need a count.
 */
export function countConnections(agent: { getConnections: () => Iterable<unknown> }): number {
  let n = 0;
  // biome-ignore lint/correctness/noUnusedVariables: counting only
  for (const _ of agent.getConnections()) n++;
  return n;
}

export interface ErrorInfo {
  name: string;
  message: string;
  cause: string | null;
  isAbort: boolean;
}

/**
 * Pull the diagnostics-relevant fields out of an arbitrary thrown
 * value. We *always* want:
 *
 *   - error class name (`AbortError`, `TypeError`, ...)
 *   - the message (truncated)
 *   - one level of `cause` (the AI SDK and `fetch` both wrap
 *     transport failures; the cause is where the actual reason
 *     lives — "TLS handshake failed", "Aborted by signal", etc.)
 *   - whether this is "an abort" — true for `AbortError`, true if
 *     the message contains "aborted" (covers DOM `AbortSignal`,
 *     stream-controller aborts, agents-SDK cancel propagation).
 *
 * Returns a small object so downstream loggers / audit writers
 * don't each re-implement the destructuring.
 */
export function describeError(err: unknown): ErrorInfo {
  if (err instanceof Error) {
    const causeRaw = (err as Error & { cause?: unknown }).cause;
    const cause = causeRaw
      ? causeRaw instanceof Error
        ? `${causeRaw.name}: ${causeRaw.message}`
        : String(causeRaw)
      : null;
    const msg = err.message ?? "";
    const isAbort =
      err.name === "AbortError" ||
      msg === "BodyStreamBuffer was aborted" ||
      msg.toLowerCase().includes("aborted");
    return {
      name: err.name || "Error",
      message: msg.slice(0, 500),
      cause: cause ? cause.slice(0, 500) : null,
      isAbort,
    };
  }
  const s = String(err);
  return {
    name: "non-error",
    message: s.slice(0, 500),
    cause: null,
    isAbort: s.toLowerCase().includes("aborted"),
  };
}
