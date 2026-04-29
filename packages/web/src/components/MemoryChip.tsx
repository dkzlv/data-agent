/**
 * "Remembered: ..." chip rendered inline next to assistant messages
 * after a `memory.remember` (task a0e754). Includes an Undo affordance
 * that hits DELETE /api/memory/:id and flips the chip to "Removed".
 *
 * One chip per `data_agent_memory_written` WS frame. Parent
 * (ChatRoom) collects frames into a `Map<turnId, writtenFacts>` and
 * renders chips alongside the matching turn — there can be ≤3 per
 * turn (REMEMBER_CALLS_PER_TURN cap).
 */
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { BookmarkPlus, Undo2, Check } from "lucide-react";
import { memoryApi } from "~/lib/api";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";

export interface WrittenFactSummary {
  id: string;
  kind: string;
  content: string;
  /** True when the row was a fresh insert; false when a re-save
   *  collapsed onto an existing fact. We render slightly different
   *  copy ("Remembered" vs "Refreshed") so the user knows the agent
   *  isn't just spamming saves. */
  inserted: boolean;
}

const KIND_LABELS: Record<string, string> = {
  schema_semantic: "Schema",
  business_def: "Business",
  user_pref: "Preference",
  query_pattern_good: "Pattern",
  query_pattern_bad: "Anti-pattern",
  entity: "Entity",
  chat_summary: "Summary",
};

export function MemoryChip({ fact }: { fact: WrittenFactSummary }): React.ReactElement {
  // Local "removed" state so the chip can flip to a confirmation
  // without waiting for a list re-fetch (which the user might not
  // be looking at). Server-side state is authoritative; reload of
  // the memory page will reflect the soft-delete.
  const [removed, setRemoved] = useState(false);
  const undo = useMutation({
    mutationFn: () => memoryApi.remove(fact.id),
    onSuccess: () => setRemoved(true),
  });

  if (removed) {
    return (
      <div className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-muted/30 px-2 py-1 text-xs text-muted-foreground">
        <Check className="h-3.5 w-3.5" />
        Removed
      </div>
    );
  }

  return (
    <div className="inline-flex max-w-full items-start gap-2 rounded-md border border-dashed border-border/60 bg-muted/30 px-2 py-1.5 text-xs">
      <BookmarkPlus className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-muted-foreground">
          {fact.inserted ? "Remembered" : "Refreshed"}
          <Badge variant="muted" className="ml-1.5 align-middle">
            {KIND_LABELS[fact.kind] ?? fact.kind}
          </Badge>
        </p>
        <p className="break-words text-foreground/80">{fact.content}</p>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={() => undo.mutate()}
        disabled={undo.isPending}
        aria-label="Undo (forget this fact)"
        title="Forget this fact"
      >
        <Undo2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
