/**
 * `cn` — class-name composer used by shadcn components.
 * Merges conditional class lists and resolves conflicting Tailwind
 * utilities so the last-specified class wins (e.g. `cn("p-2", "p-4")`
 * yields `p-4`).
 */
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
