/** "#161616", "#fff" or "rgb(22, 22, 22)" as "#rrggbb"; anything else (a gradient, a variable) is not usable. */
export function hexOf(css: string): string | undefined {
  const v = css.trim().toLowerCase();
  const long = /^#([0-9a-f]{6})$/.exec(v); if (long) return `#${long[1]}`;
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(v); if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  const rgb = /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/.exec(v);
  if (rgb) return `#${[rgb[1], rgb[2], rgb[3]].map((n) => Math.min(255, Number(n)).toString(16).padStart(2, "0")).join("")}`;
  return undefined;
}
