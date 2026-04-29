/**
 * Memory management page (task a0e754).
 *
 * Read-only v1: list facts for one dbProfile, filter by kind +
 * substring, delete. No "add" button — memory is built automatically
 * by the agent and the post-turn extractor (see chat-agent/memory).
 *
 * Linked from `app.db-profiles.tsx` rows: each profile gets a small
 * "Memory" affordance that routes here.
 */
import { useMemo, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { dbProfilesApi, memoryApi, type MemoryFact } from "~/lib/api";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { ListSkeleton } from "~/components/list-skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { AppMobileNavTrigger, AppPageScroll } from "~/routes/app";

export const Route = createFileRoute("/app/memory/$dbProfileId")({
  component: MemoryRoute,
});

/**
 * UI labels mirror the server-side MEMORY_KIND_LABELS map. Duplicated
 * (rather than imported from @data-agent/shared) to keep the web
 * bundle decoupled from the Workers-shaped `shared` package.
 */
const KIND_LABELS: Record<MemoryFact["kind"], string> = {
  schema_semantic: "Schema",
  business_def: "Business",
  user_pref: "Preference",
  query_pattern_good: "Pattern",
  query_pattern_bad: "Anti-pattern",
  entity: "Entity",
  chat_summary: "Summary",
};
const ALL_KINDS = Object.keys(KIND_LABELS) as Array<MemoryFact["kind"]>;

function MemoryRoute() {
  const { dbProfileId } = Route.useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const profile = useQuery({
    queryKey: ["db-profiles"],
    queryFn: () => dbProfilesApi.list().then((r) => r.profiles),
    select: (rows) => rows.find((p) => p.id === dbProfileId),
  });

  const [kindFilter, setKindFilter] = useState<MemoryFact["kind"] | null>(null);
  const [q, setQ] = useState("");
  // Debounce-ish: we just use the immediate value but the list query
  // is cheap (cursor-paginated), so re-firing on each keystroke is
  // fine for the short v1 search. If this becomes a perf problem
  // (it won't for a 5k-fact cap), wrap with `useDeferredValue`.
  const list = useQuery({
    queryKey: ["memory", dbProfileId, kindFilter, q],
    queryFn: () =>
      memoryApi.list({
        dbProfileId,
        ...(kindFilter ? { kind: kindFilter } : {}),
        ...(q ? { q } : {}),
        limit: 100,
      }),
  });

  const [confirmDelete, setConfirmDelete] = useState<MemoryFact | null>(null);

  const remove = useMutation({
    mutationFn: (id: string) => memoryApi.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["memory", dbProfileId] });
      setConfirmDelete(null);
    },
  });

  // Group facts by kind for the visible list. Order within a group is
  // newest-first (server returns desc createdAt), and we show groups
  // in the kind-list order (schema first → summary last) for stable
  // rendering when the user toggles filters.
  const grouped = useMemo(() => {
    const map = new Map<MemoryFact["kind"], MemoryFact[]>();
    for (const k of ALL_KINDS) map.set(k, []);
    for (const fact of list.data?.facts ?? []) {
      map.get(fact.kind)?.push(fact);
    }
    return [...map.entries()].filter(([, rows]) => rows.length > 0);
  }, [list.data]);

  return (
    <AppPageScroll>
      <div className="mx-auto max-w-4xl space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <AppMobileNavTrigger />
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">
                {profile.data?.name ? `Memory — ${profile.data.name}` : "Memory"}
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {list.data ? (
                  <>
                    {list.data.total === 0
                      ? "No facts saved yet."
                      : `${list.data.total} fact${list.data.total === 1 ? "" : "s"} learned across chats with this database.`}
                  </>
                ) : (
                  "Facts the agent has learned across chats with this database."
                )}
              </p>
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={() => navigate({ to: "/app/db-profiles" })}>
            Back to connections
          </Button>
        </header>

        <div className="space-y-3">
          <Input
            placeholder="Search facts…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="max-w-md"
          />
          <div className="flex flex-wrap gap-1.5">
            <FilterChip
              active={kindFilter === null}
              label="All"
              onClick={() => setKindFilter(null)}
            />
            {ALL_KINDS.map((k) => (
              <FilterChip
                key={k}
                active={kindFilter === k}
                label={KIND_LABELS[k]}
                onClick={() => setKindFilter(k)}
              />
            ))}
          </div>
        </div>

        {list.isLoading && <ListSkeleton rows={4} trailing />}

        {list.error && (
          <Alert variant="destructive">
            <AlertDescription>{(list.error as Error).message}</AlertDescription>
          </Alert>
        )}

        {list.data && list.data.facts.length === 0 && (
          <div className="rounded-lg border border-dashed border-border bg-card p-10 text-center">
            <p className="text-sm font-medium">
              {q || kindFilter ? "No facts match your filters." : "No facts yet."}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {q || kindFilter
                ? "Try a broader search or different category."
                : "Memory is built automatically as you chat about this database."}
            </p>
          </div>
        )}

        {grouped.length > 0 && (
          <div className="space-y-6">
            {grouped.map(([kind, rows]) => (
              <section key={kind} className="space-y-2">
                <h2 className="text-sm font-medium text-muted-foreground">
                  {KIND_LABELS[kind]} <span className="text-xs">({rows.length})</span>
                </h2>
                <ul className="divide-y divide-border rounded-lg border border-border bg-card">
                  {rows.map((f) => (
                    <FactRow
                      key={f.id}
                      fact={f}
                      onDelete={() => setConfirmDelete(f)}
                      isDeleting={remove.isPending && remove.variables === f.id}
                    />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}

        <ConfirmDeleteDialog
          fact={confirmDelete}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => confirmDelete && remove.mutate(confirmDelete.id)}
          isPending={remove.isPending}
        />
      </div>
    </AppPageScroll>
  );
}

function FilterChip({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant={active ? "default" : "ghost"}
      size="sm"
      onClick={onClick}
      className="h-7 text-xs"
    >
      {label}
    </Button>
  );
}

function FactRow({
  fact,
  onDelete,
  isDeleting,
}: {
  fact: MemoryFact;
  onDelete: () => void;
  isDeleting: boolean;
}) {
  const created = new Date(fact.createdAt);
  const ago = formatRelative(created);
  return (
    <li className="flex flex-wrap items-start gap-3 px-4 py-3 sm:flex-nowrap">
      <div className="min-w-0 flex-1">
        <p className="text-sm">{fact.content}</p>
        <p className="mt-1 truncate text-xs text-muted-foreground">
          <Badge variant="muted" className="mr-2">
            {KIND_LABELS[fact.kind]}
          </Badge>
          saved {ago}
          {fact.hitCount > 0 ? ` · used ${fact.hitCount}×` : ""}
        </p>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Delete fact"
        onClick={onDelete}
        disabled={isDeleting}
        className="text-destructive hover:text-destructive"
      >
        <Trash2 className="h-4 w-4" />
      </Button>
    </li>
  );
}

function ConfirmDeleteDialog({
  fact,
  onCancel,
  onConfirm,
  isPending,
}: {
  fact: MemoryFact | null;
  onCancel: () => void;
  onConfirm: () => void;
  isPending: boolean;
}) {
  return (
    <Dialog open={!!fact} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete this fact?</DialogTitle>
          <DialogDescription>
            The agent will no longer reference this in future chats. You can't undo from this page.
          </DialogDescription>
        </DialogHeader>
        {fact && (
          <p className="rounded-md border border-border bg-muted/30 p-3 text-sm">{fact.content}</p>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} disabled={isPending}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={isPending}>
            {isPending ? "Deleting…" : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Tiny relative-time formatter — sufficient for this surface. */
function formatRelative(d: Date): string {
  const ms = Date.now() - d.getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(months / 12);
  return `${years}y ago`;
}
