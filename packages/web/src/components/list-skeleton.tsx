import { Skeleton } from "~/components/ui/skeleton";
import { cn } from "~/lib/utils";

/**
 * ListSkeleton — generic loading placeholder for divider-separated
 * lists. The dimensions match the real list rows: 4-col padding,
 * py-3, with one wider title line (h-4) above a narrower sub line
 * (h-3). Pass `rows` to control density and `withSub` to show or
 * hide the secondary line (e.g. tight tile lists).
 *
 * Used by:
 *   - ChatsRoute  (rows = 4, default sub line)
 *   - DbProfilesRoute (rows = 3, default sub line + trailing badges)
 *   - WorkspaceSidebar (rows = 5, compact density)
 */
export function ListSkeleton({
  rows = 4,
  withSub = true,
  trailing = false,
  dense = false,
  className,
}: {
  rows?: number;
  withSub?: boolean;
  trailing?: boolean;
  dense?: boolean;
  className?: string;
}) {
  return (
    <ul
      className={cn("divide-y divide-border rounded-lg border border-border bg-card", className)}
      aria-busy="true"
      aria-label="Loading"
    >
      {Array.from({ length: rows }).map((_, i) => (
        <li key={i} className={cn("flex items-center gap-3 px-4", dense ? "py-2.5" : "py-3")}>
          <div className="min-w-0 flex-1 space-y-2">
            {/* Width pseudo-randomized by row index for natural rhythm */}
            <Skeleton className="h-4" style={{ width: `${55 + ((i * 13) % 35)}%` }} />
            {withSub && <Skeleton className="h-3" style={{ width: `${30 + ((i * 17) % 25)}%` }} />}
          </div>
          {trailing && (
            <>
              <Skeleton className="h-5 w-12 rounded-full" />
              <Skeleton className="h-3 w-8" />
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * SidebarItemSkeleton — single tight tile used in the chat workspace
 * sidebar list. Smaller padding, single-line glyph + label + meta.
 */
export function SidebarItemSkeleton() {
  return (
    <div className="flex items-center gap-2 px-3 py-2">
      <Skeleton className="h-3.5 w-3.5 rounded-sm" />
      <Skeleton className="h-3.5 flex-1" />
      <Skeleton className="h-3 w-6" />
    </div>
  );
}
