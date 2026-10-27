/** `v` limited to min..max when it is a finite number, otherwise `fallback` (stored preferences can hold anything). */
export function clampTo(v: unknown, min: number, max: number, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}
