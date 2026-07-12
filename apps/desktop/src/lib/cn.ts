/**
 * Forge Desktop — class name combiner.
 *
 * Combines clsx (conditional class assembly) with tailwind-merge
 * (deduplicates conflicting Tailwind classes). Per design constraints:
 * "Use `clsx` + `tailwind-merge` for conditional classes (already in deps)."
 */
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
