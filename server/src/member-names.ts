// Names for sessions (`@name`). Stored once, in Korean: the UI language only decides which form is shown (민수 / Minsu),
// so switching the language never renames anything and two clients in different languages still agree on the name.

/** Korean names, given to sessions in order; the first one not taken by an active session is used. */
export const MEMBER_NAMES_KO = [
	"철수", "미나", "가온", "영희", "민준", "나린", "지우", "도하", "하준", "라희",
	"서연", "도윤", "서준", "예준", "시우", "주원", "지호", "지후", "준우", "현우",
	"도현", "건우", "우진", "승민", "유준", "재민", "태양", "선우", "은호", "정우",
	"시윤", "이안", "라온", "다온", "이든", "단우", "로운", "서진", "재윤", "민재",
	"성민", "동현", "영수", "상철", "지훈", "병철", "광수", "종호", "기태", "용준",
	"세훈", "수현", "현준", "윤호", "태민", "규민", "찬영", "서윤", "서아", "지아",
	"하윤", "하은", "지유", "수아", "지안", "윤서", "채원", "다은", "예은", "유나",
	"소율", "아린", "나은", "가은", "시은", "예린", "세아", "민서", "지민", "수빈",
	"유진", "은지", "혜진", "소연", "다인", "하린", "채은", "나연", "해인", "다현",
	"선아", "연우", "주아", "은서", "유리", "아영", "정아", "현아", "승아", "경미",
	"온유", "혜린", "재현", "민호", "성훈", "진우", "태준", "승현", "지원", "하람",
	"시현", "도훈", "준서", "예성", "은우", "지환", "동윤", "현서", "서현", "지수",
	"예지", "하영", "수진", "유경", "다영", "세린", "가영", "나윤", "소민",
	"유빈", "지은", "아윤", "예서", "채린", "민지", "민규", "민석", "민우", "민혁",
	"민철", "민기", "민수", "지석", "지성", "지웅", "지혁", "지완", "지명", "지태", "시후",
	"시원", "시온", "시헌", "시율", "서호", "서원", "서빈", "서율", "서인", "서하",
	"도영", "도진", "도율", "도원", "도준", "도경", "도빈", "하진", "하율", "하민",
	"하성", "현석", "현진", "현호", "현규", "현빈", "현성", "태영", "태윤", "태진",
	"태호", "태현", "태건", "승우", "승훈", "승준", "승호", "승원", "승재", "우석",
	"우빈", "우성", "우혁", "정훈", "정호", "정현", "정민", "정빈", "정원", "준영",
];

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

/** The Korean pool romanized (민수 -> Minsu): the same name in a Latin-script UI, never a second name of its own. */
export const MEMBER_NAMES_EN = MEMBER_NAMES_KO.map(romanize);

const SUFFIX = /\d+$/;

/** The next free name given the lower-cased names in use, then 철수2, 철수3, ... (the pool is always the stored, Korean one). */
export function nextMemberName(taken: ReadonlySet<string>, pool: readonly string[] = MEMBER_NAMES_KO): string {
	const free = pool.find((n) => !taken.has(n.toLowerCase()));
	if (free) return free;
	for (let n = 2; ; n++) if (!taken.has(`${pool[0]}${n}`.toLowerCase())) return `${pool[0]}${n}`;
}

/** The Korean name a stored name stands for: a name saved before names became language-neutral may still be romanized. */
export function koreanName(name: string): string {
	if (MEMBER_NAMES_KO.includes(name)) return name;
	const base = name.replace(SUFFIX, "");
	const suffix = name.slice(base.length);
	const i = MEMBER_NAMES_EN.findIndex((n) => n.toLowerCase() === base.toLowerCase());
	return i >= 0 ? MEMBER_NAMES_KO[i]! + suffix : name;
}

/**
 * The name as one language writes it: the Korean name itself, or its romanization (민수 <-> Minsu, 민수2 <-> Minsu2).
 * Display only — the stored name stays Korean. A name from outside the pool is returned as it is.
 */
export function nameInLang(name: string, lang?: string): string {
	if (!lang || /^ko(?:-|$)/i.test(lang)) return koreanName(name);
	const ko = koreanName(name);
	const base = ko.replace(SUFFIX, "");
	return MEMBER_NAMES_KO.includes(base) ? romanize(base) + ko.slice(base.length) : ko;
}

/**
 * The key two names are compared by: the Korean form, lower-cased. 철수, Cheolsu and cheolsu2-less variants all map to one
 * key, so a language never makes two sessions look different (or lets two sessions share a name). Taken-name sets,
 * lookups, renames and `@mentions` all go through this.
 */
export const nameKey = (name: string): string => koreanName(name).toLowerCase();

/** Whether two written names mean the same session: either one's stored form or the form an English UI shows (민수 = Minsu). */
export const sameName = (a: string, b: string): boolean => nameKey(a) === nameKey(b);

/** What a group is called in a message: its name with whitespace turned into "-" so the tag stays one token. */
export const groupHandle = (name: string): string => name.trim().replace(/\s+/g, "-");

/**
 * The member a `@name` token starts with, written in either language (@미나, @Mina): the longest known name, not cut out of
 * a longer ASCII word (Korean particles may follow: @미나랑). Returns the name as it is in `names`.
 */
export function memberAt(token: string, names: readonly string[]): string | null {
	const low = token.toLowerCase();
	let best: string | null = null;
	let bestLen = 0;
	for (const n of names) {
		for (const written of new Set([n.toLowerCase(), nameInLang(n, "ko").toLowerCase(), nameInLang(n, "en").toLowerCase()])) {
			if (!low.startsWith(written) || written.length <= bestLen) continue;
			if (/[a-z0-9_-]$/.test(written) && /^[a-z0-9_-]/.test(low.slice(written.length))) continue;
			best = n;
			bestLen = written.length;
		}
	}
	return best;
}

/** Names written as `@name` in a message, limited to known ones, in order of appearance, without repeats. */
export function mentioned(text: string, names: readonly string[]): string[] {
	const out: string[] = [];
	for (const m of text.matchAll(/(?:^|\s)@(\S+)/g)) {
		const name = memberAt(m[1]!, names);
		if (name && !out.includes(name)) out.push(name);
	}
	return out;
}
