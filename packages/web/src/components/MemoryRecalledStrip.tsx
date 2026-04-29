/**
 * "Used N facts from past chats" strip (task a0e754).
 *
 * Renders above an assistant message when the chat-agent broadcast
 * a `data_agent_memory_recall` frame for that turn. Collapsed by
 * default — the user clicks to expand the actual fact list.
 *
 * Why a strip and not inline citations? Inline would clutter the
 * answer and mislead the eye toward "this number came from a
 * recalled fact" — recalled facts are *context* the model used,
 * not citations of the data. The strip makes the relationship
 * explicit while staying out of the way.
 *
 * State lifecycle: the parent (ChatRoom) holds a `Map<turnId,
 * recalledFacts>` keyed off the WS frame and renders one strip per
 * turn. The strip itself is presentational — receives the fact
 * list as a prop.
 */
import { useState } from "react";
import { Sparkles, ChevronDown } from "lucide-react";
import { Badge } from "~/components/ui/badge";
import { cn } from "~/lib/utils";

export interface RecalledFactSummary {
  id: string;
  kind: string;
  content: string;
  /** Vectorize cosine score, post-curation-boost. Surfaced on hover
   *  so the operator-curious user can see why a fact ranked. */
  score: number;
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

export function MemoryRecalledStrip({
  facts,
}: {
  facts: ReadonlyArray<RecalledFactSummary>;
}): React.ReactElement | null {
  const [expanded, setExpanded] = useState(false);
  if (!facts || facts.length === 0) return null;

  return (
    <div
      className={cn(
        "rounded-md border border-dashed border-border/60 bg-muted/30 px-3 py-1.5 text-xs",
        expanded ? "space-y-2" : ""
      )}
    >
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 text-muted-foreground hover:text-foreground"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="flex items-center gap-1.5">
          <Sparkles className="h-3.5 w-3.5" />
          Used {facts.length} fact{facts.length === 1 ? "" : "s"} from past chats
        </span>
        <ChevronDown
          className={cn("h-3.5 w-3.5 transition-transform", expanded ? "rotate-180" : "")}
        />
      </button>
      {expanded && (
        <ul className="space-y-1">
          {facts.map((f) => (
            <li key={f.id} className="flex items-start gap-1.5">
              <Badge variant="muted" className="shrink-0">
                {KIND_LABELS[f.kind] ?? f.kind}
              </Badge>
              <span
                className="flex-1 text-foreground/80"
                title={`relevance: ${f.score.toFixed(3)}`}
              >
                {f.content}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
