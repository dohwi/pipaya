/**
 * Compares `major.minor.patch` version triples; returns -1 / 0 / 1, or null if either is not a valid triple.
 * Shared across server self-update checks and client protocol compatibility.
 */
export function compareVersions(a: string | null | undefined, b: string | null | undefined): number | null {
	const parse = (v: string | null | undefined) => {
		const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v?.trim() ?? "");
		return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
	};
	const x = parse(a);
	const y = parse(b);
	if (!x || !y) return null;
	for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
	return 0;
}
