/** True when `pattern` matches the whole of `value`. JavaScript's `$` also matches before a final newline, so `^...$` alone lets "x\n" through. */
export function matches(pattern: RegExp, value: string): boolean {
	return pattern.exec(value)?.[0] === value;
}
