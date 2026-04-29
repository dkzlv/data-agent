/**
 * ScrollArea — thin wrapper around `@base-ui-components/react`'s
 * unstyled scroll-area parts. Replaces the radix-based ScrollArea
 * we shipped originally; base-ui's API exposes a `viewport` ref-able
 * element that the chat history needs for stick-to-bottom autoscroll
 * (radix wrapped the viewport opaquely and made measuring tricky).
 *
 * Usage:
 *   <ScrollArea className="h-64">
 *     ...content...
 *   </ScrollArea>
 *
 * Or, when you need the viewport DOM node (e.g. to measure scroll
 * position), use the parts directly:
 *
 *   <ScrollAreaRoot>
 *     <ScrollAreaViewport ref={viewportRef}>...</ScrollAreaViewport>
 *     <ScrollAreaScrollbar><ScrollAreaThumb /></ScrollAreaScrollbar>
 *   </ScrollAreaRoot>
 */
import * as React from "react";
import { ScrollArea as Base } from "@base-ui-components/react/scroll-area";

import { cn } from "~/lib/utils";

// --- compound parts (escape hatch for callers that need refs / fine
// control over viewport) ---
//
// `group/scroll-area` is intentionally on Root so siblings (notably
// `ScrollAreaFades`) can read base-ui's overflow data attributes via
// Tailwind group selectors (`group-data-[overflow-y-start]/...`).
// Without it the fade overlays can't tell whether content is scrolled
// off the top/bottom and we lose the affordance.
const ScrollAreaRoot = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof Base.Root>
>(({ className, ...props }, ref) => (
  <Base.Root
    ref={ref}
    className={cn("group/scroll-area relative overflow-hidden", className)}
    {...props}
  />
));
ScrollAreaRoot.displayName = "ScrollAreaRoot";

const ScrollAreaViewport = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof Base.Viewport>
>(({ className, ...props }, ref) => (
  <Base.Viewport
    ref={ref}
    // outline-none: viewport is focusable for keyboard scrolling but
    // the default focus ring fights our card borders.
    className={cn("h-full w-full overscroll-contain rounded-[inherit] outline-none", className)}
    {...props}
  />
));
ScrollAreaViewport.displayName = "ScrollAreaViewport";

const ScrollAreaScrollbar = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof Base.Scrollbar>
>(({ className, orientation = "vertical", ...props }, ref) => (
  <Base.Scrollbar
    ref={ref}
    orientation={orientation}
    className={cn(
      // Match the prior radix styling so the visual weight is identical.
      // p-[1px] keeps the thumb a hair away from the rail edge so it
      // doesn't ride the border.
      "flex touch-none select-none p-[1px] transition-opacity",
      "data-[hovering]:opacity-100 data-[scrolling]:opacity-100",
      orientation === "vertical" && "h-full w-2.5 border-l border-l-transparent",
      orientation === "horizontal" && "h-2.5 w-full flex-col border-t border-t-transparent",
      className
    )}
    {...props}
  />
));
ScrollAreaScrollbar.displayName = "ScrollAreaScrollbar";

const ScrollAreaThumb = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof Base.Thumb>
>(({ className, ...props }, ref) => (
  <Base.Thumb
    ref={ref}
    className={cn("relative flex-1 rounded-full bg-border", className)}
    {...props}
  />
));
ScrollAreaThumb.displayName = "ScrollAreaThumb";

// --- convenience wrapper (matches the prior radix-based ScrollArea
// API so existing call-sites in WorkspaceSidebar keep working) ---
interface ScrollAreaProps extends React.ComponentPropsWithoutRef<typeof Base.Root> {
  /** Class applied to the inner viewport (where the content lives). */
  viewportClassName?: string;
  /** Forwarded to the viewport so callers can imperatively scroll. */
  viewportRef?: React.Ref<HTMLDivElement>;
}

const ScrollArea = React.forwardRef<HTMLDivElement, ScrollAreaProps>(
  ({ className, children, viewportClassName, viewportRef, ...props }, ref) => (
    <ScrollAreaRoot ref={ref} className={className} {...props}>
      <ScrollAreaViewport ref={viewportRef} className={viewportClassName}>
        {children}
      </ScrollAreaViewport>
      <ScrollAreaScrollbar>
        <ScrollAreaThumb />
      </ScrollAreaScrollbar>
      <Base.Corner />
    </ScrollAreaRoot>
  )
);
ScrollArea.displayName = "ScrollArea";

// Backward-compatible re-export — the prior file exported `ScrollBar`.
const ScrollBar = ScrollAreaScrollbar;

/**
 * ScrollAreaFades — gradient overlays that fade in when content
 * overflows on either side. Pattern lifted from indent-1's
 * `js_modules/client/src/components/ui/scroll-area/scroll-area.tsx`:
 * place as a sibling of `ScrollAreaViewport` inside a
 * `ScrollAreaRoot` (or any element carrying the
 * `group/scroll-area` class) so the fades can read overflow state
 * from base-ui's `data-overflow-y-start` / `data-overflow-y-end`
 * attributes via group selectors.
 *
 * The gradient pulls from `currentColor` → `transparent`, so set
 * `color` to a `text-*` utility matching the scroll-area's own
 * background. Default is `text-card` (matches the message-list
 * panel) but consumers can override for sidebars, popovers, etc.
 *
 * Why CSS-only (vs. measuring scrollTop in JS): base-ui already
 * computes the overflow state for its scrollbar visibility; reusing
 * it avoids a parallel rAF loop and keeps the fade in sync with the
 * scrollbar's auto-hide transitions.
 */
type ScrollAreaFadesOrientation = "vertical" | "horizontal" | "both";

const ScrollAreaFades = ({
  color = "text-card",
  orientation = "vertical",
  size = "1rem",
}: {
  /** Tailwind text utility for the fade color (must match background). */
  color?: `text-${string}`;
  orientation?: ScrollAreaFadesOrientation;
  /** Length of each fade band along the scroll axis. */
  size?: string;
}) => {
  const showVertical = orientation === "vertical" || orientation === "both";
  const showHorizontal = orientation === "horizontal" || orientation === "both";
  const base =
    "pointer-events-none absolute z-10 from-current to-transparent opacity-0 transition-opacity duration-150";
  return (
    <>
      {showVertical && (
        <>
          <div
            aria-hidden
            style={{ height: size }}
            className={cn(
              base,
              "inset-x-0 top-0 bg-linear-to-b group-data-[overflow-y-start]/scroll-area:opacity-100",
              color
            )}
          />
          <div
            aria-hidden
            style={{ height: size }}
            className={cn(
              base,
              "inset-x-0 bottom-0 bg-linear-to-t group-data-[overflow-y-end]/scroll-area:opacity-100",
              color
            )}
          />
        </>
      )}
      {showHorizontal && (
        <>
          <div
            aria-hidden
            style={{ width: size }}
            className={cn(
              base,
              "inset-y-0 left-0 bg-linear-to-r group-data-[overflow-x-start]/scroll-area:opacity-100",
              color
            )}
          />
          <div
            aria-hidden
            style={{ width: size }}
            className={cn(
              base,
              "inset-y-0 right-0 bg-linear-to-l group-data-[overflow-x-end]/scroll-area:opacity-100",
              color
            )}
          />
        </>
      )}
    </>
  );
};
ScrollAreaFades.displayName = "ScrollAreaFades";

export {
  ScrollArea,
  ScrollBar,
  ScrollAreaRoot,
  ScrollAreaViewport,
  ScrollAreaScrollbar,
  ScrollAreaThumb,
  ScrollAreaFades,
};
