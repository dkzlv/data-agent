import { cn } from "~/lib/utils";

/**
 * Skeleton — a low-contrast pulsing block used to reserve space while
 * data loads. Pass exact dimensions via Tailwind utilities so the
 * skeleton matches what's about to take its place; that's the whole
 * point — the layout shouldn't shift when content arrives.
 */
function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("animate-pulse rounded-md bg-muted/80 dark:bg-muted/60", className)}
      {...props}
    />
  );
}

export { Skeleton };
