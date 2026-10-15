// The eight pipaya expressions (eyes only). The mark centres the eye region on the trunk, so there is no per-face offset.
export const FACES = {
	block: { eyes: ["M-14 -5.5L-6 -5.5L-6 5.5L-14 5.5Z", "M6 -5.5L14 -5.5L14 5.5L6 5.5Z"] },
	slit: { eyes: ["M-15 -2L-5 -2L-5 2L-15 2Z", "M5 -2L15 -2L15 2L5 2Z"] },
	pixel: { eyes: ["M-14 -5L-8 -5L-6 -3L-6 5L-12 5L-14 3Z", "M6 -3L8 -5L14 -5L14 3L12 5L6 5Z"] },
	happy: { eyes: ["M-15 2L-11 -3L-9 -3L-5 2L-7 4.5L-10 1L-13 4.5Z", "M5 2L9 -3L11 -3L15 2L13 4.5L10 1L7 4.5Z"] },
	focus: { eyes: ["M-15 -5L-5 -1L-5 5L-15 1Z", "M5 -1L15 -5L15 1L5 5Z"] },
	curious: { eyes: ["M-14 -3L-6 -3L-6 3L-14 3Z", "M5 -6.5L14 -6.5L14 6.5L5 6.5Z"] },
	wink: { eyes: ["M-14 -5.5L-6 -5.5L-6 5.5L-14 5.5Z", "M5 2L9 -3L11 -3L15 2L13 4.5L10 1L7 4.5Z"] },
	sleepy: { eyes: ["M-15 -2L-5 -2L-7 2L-13 2Z", "M5 -2L15 -2L13 2L7 2Z"] },
} as const;

export type FaceName = keyof typeof FACES;
export const FACE_NAMES = Object.keys(FACES) as FaceName[];

/** Each session keeps one expression for good: random-looking, but stable across reloads and devices. */
export function faceFor(id: string | null | undefined): FaceName {
	let h = 2166136261;
	for (const c of id ?? "") h = Math.imul(h ^ c.charCodeAt(0), 16777619);
	return FACE_NAMES[(h >>> 0) % FACE_NAMES.length]!;
}
