/**
 * How a session's `@name` is written. The server stores one name per session, always in Korean (민수); the UI language only
 * decides which form is shown (민수 in Korean, Minsu in English). So switching the language never renames anything on the
 * server, and two clients in different languages still address the same session: `@mention` and `peer(action=…)` use the
 * stored name, the romanized one is display only.
 *
 * Same rule as `server/src/member-names.ts` (Revised Romanization, syllable by syllable); a name with no Hangul in it is
 * shown as it is.
 */
import { getLang } from "./i18n";

const INITIALS = ["g", "kk", "n", "d", "tt", "r", "m", "b", "pp", "s", "ss", "", "j", "jj", "ch", "k", "t", "p", "h"];
const VOWELS = ["a", "ae", "ya", "yae", "eo", "e", "yeo", "ye", "o", "wa", "wae", "oe", "yo", "u", "wo", "we", "wi", "yu", "eu", "ui", "i"];
const FINALS = ["", "k", "k", "k", "n", "n", "n", "t", "l", "k", "m", "l", "l", "l", "p", "l", "m", "p", "p", "t", "t", "ng", "t", "t", "k", "t", "p", "t"];

/** Revised Romanization of a Hangul name, syllable by syllable (민수 -> Minsu); anything else is kept as it is. */
export function romanize(name: string): string {
	let out = "";
	for (const ch of name) {
		const code = ch.charCodeAt(0) - 0xac00;
		out += code >= 0 && code <= 11171 ? INITIALS[Math.floor(code / 588)]! + VOWELS[Math.floor((code % 588) / 28)]! + FINALS[code % 28]! : ch;
	}
	return out.charAt(0).toUpperCase() + out.slice(1);
}

/**
 * The name as the UI language writes it: the stored Korean name, or its romanization (민수 <-> Minsu, 민수2 <-> Minsu2).
 * The number of a numbered name stays as it is. Reactive in a template: it reads the language signal.
 */
export function nameInLang(name: string, lang: string = getLang()): string {
	return /^ko(?:-|$)/i.test(lang) || !/[\uac00-\ud7a3]/.test(name) ? name : romanize(name);
}
