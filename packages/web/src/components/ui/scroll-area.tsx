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
const ScrollAreaRoot = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof Base.Root>
>(({ className, ...props }, ref) => (
  <Base.Root ref={ref} className={cn("relative overflow-hidden", className)} {...props} />
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

export {
  ScrollArea,
  ScrollBar,
  ScrollAreaRoot,
  ScrollAreaViewport,
  ScrollAreaScrollbar,
  ScrollAreaThumb,
};
