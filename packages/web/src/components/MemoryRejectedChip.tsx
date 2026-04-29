/**
 * "Couldn't save: ..." chip rendered alongside the regular
 * MemoryChip when the agent's `memory.remember` got rejected
 * server-side (task 996861).
 *
 * Live-only — the WS frame `data_agent_memory_write_rejected` is
 * fan-out from the chat-agent's `rejectRemember` helper. We don't
 * persist the reject in the message store, so on history replay
 * the chip simply doesn't render. The audit log
 * (`memory.remember_rejected`) is the durable record for
 * post-incident investigation.
 *
 * Why surface this at all? When the agent is silently dropping
 * saves (the original bug shape on chat 5f2690a6 — schema-shaped
 * facts hitting `MEMORY_CONTENT_MAX = 500`) the user has no way of
 * knowing. The reject chip closes that gap with a one-line warning
 * the user can read inline.
 */
import { AlertTriangle } from "lucide-react";

export interface RejectedSaveSummary {
  /** Server-coined reason code. Drives the human-readable copy. */
  reason: string;
  /** The kind the model tried to save (or "(non-string)" when arg
   *  shape was wrong). Useful for at-a-glance "ah, schema fact". */
  kind: string;
  /** Length the model tried to save. -1 when content wasn't a
   *  string. Surfaced in the "too long" copy so the user can see
   *  by how much. */
  contentChars: number;
}

/**
 * Map of server reason codes → user-facing copy. Keep these short
 * — the chip is a one-liner. Anything beyond this set falls
 * through to the generic "couldn't save (see logs)" copy. The set
 * mirrors the codes minted in `chat-agent/memory/tools.ts`'s
 * `rejectRemember` helper.
 */
function describeReason(r: RejectedSaveSummary): string {
  switch (r.reason) {
    case "content_invalid":
      // We only ever surface character-shape rejects this way; the
      // server-side reason is more specific (too short / too long /
      // not a string). Nudge toward "break it up" because that's
      // the right move 95% of the time after the 500→2000 bump.
      if (r.contentChars > 0) {
        return `fact too long (${r.contentChars} chars) — broke into smaller pieces?`;
      }
      return "fact too short or wrong shape";
    case "per_turn_cap_reached":
      return "memory save cap hit (3/turn)";
    case "tenant_or_profile_missing":
      return "no database attached";
    case "reserved_kind":
      return `kind "chat_summary" is reserved`;
    case "unknown_kind":
      return "unknown memory kind";
    case "args_not_object":
      return "malformed save call";
    default:
      return "couldn't save (see logs)";
  }
}

/**
 * Warn-toned amber pair below matches the Alert component's `warn`
 * variant — there's no dedicated `--warning` token in this project,
 * raw amber-* Tailwind utilities are the convention.
 */
export function MemoryRejectedChip({
  rejected,
}: {
  rejected: RejectedSaveSummary;
}): React.ReactElement {
  return (
    <div className="inline-flex max-w-full items-start gap-2 rounded-md border border-dashed border-amber-300/60 bg-amber-50 px-2 py-1.5 text-xs text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/40 dark:text-amber-200">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-700 dark:text-amber-300" />
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="opacity-80">Couldn't save</p>
        <p className="break-words">{describeReason(rejected)}</p>
      </div>
    </div>
  );
}
