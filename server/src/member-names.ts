// Names for sessions (`@name`). Stored once, in Korean: the UI language only decides which form is shown (민수 / Minsu),
// so switching the language never renames anything and two clients in different languages still agree on the name.

/** Korean names, given to sessions in order; the first one no session carries (closed ones keep theirs) is used. */
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
	"준혁", "준호", "준희", "준기", "준모", "준범", "준상", "준석", "준성", "준수",
	"준식", "준용", "준원", "준일", "준하", "준현", "준형", "준환", "성호", "성현",
	"성준", "성진", "성우", "성수", "성식", "성원", "성윤", "성일", "성재", "성주",
	"성철", "성태", "성하", "성한", "성혁", "성환", "성희", "동욱", "동하", "동훈",
	"동규", "동민", "동석", "동수", "동식", "동영", "동우", "동원", "동일", "동재",
	"동주", "동준", "동진", "동철", "동혁", "동호", "동환", "동희", "재원", "재훈",
	"재호", "재성", "재영", "재우", "재웅", "재유", "재이", "재익", "재일", "재준",
	"재진", "재찬", "재하", "재학", "재혁", "재형", "재홍", "재환", "재희", "영민",
	"영준", "영진", "영호", "영훈", "영기", "영남", "영대", "영덕", "영도", "영동",
	"영모", "영범", "영보", "영복", "영빈", "영상", "영서", "영석", "영선", "영섭",
	"영성", "영식", "영신", "영안", "영언", "영오", "영옥", "영완", "영용", "영우",
	"영욱", "영운", "영원", "영유", "영윤", "영일", "영자", "영재", "영정", "영조",
	"영주", "영지", "영찬", "영창", "영철", "영춘", "영태", "영하", "영한", "영해",
	"영혁", "영현", "영형", "영환", "상우", "상훈", "상현", "상준", "상민", "상호",
	"상진", "상혁", "상원", "상윤", "상수", "상욱", "상일", "상재", "상주", "상하",
	"상한", "상희", "진호", "진혁", "진성", "진수", "진영", "진원", "진일", "진주",
	"진하", "진한", "진현", "진형", "진환", "진희", "기훈", "기현", "기영", "기성",
	"기수", "기원", "기윤", "기정", "기주", "기준", "기철", "기하", "기호", "기환",
	"용진", "용호", "용훈", "용기", "용민", "용석", "용성", "용수", "용우", "용욱",
	"용원", "용일", "용재", "용주", "용철", "용하", "용현", "용환", "용희", "세영",
	"세진", "세현", "세호", "세원", "세윤", "세정", "세준", "세찬", "세하", "세희",
	"수영", "수호", "수훈", "수민", "수성", "수연", "수완", "수용", "수원", "수윤",
	"수인", "수정", "수종", "수지", "수찬", "수철", "수하", "수한", "수혁", "수형",
	"수환", "수희", "윤재", "윤진", "윤하", "윤기", "윤미", "윤민", "윤석", "윤성",
	"윤수", "윤영", "윤우", "윤원", "윤정", "윤주", "윤지", "윤철", "윤태",
	"윤한", "윤혁", "윤현", "윤형", "윤환", "윤희", "규현", "규호", "규태", "규성",
	"규영", "규원", "규진", "규철", "규하", "규한", "규혁", "규환", "찬우", "찬호",
	"찬희", "찬기", "찬민", "찬석", "찬성", "찬수", "찬양", "찬열", "찬오", "찬용",
	"찬욱", "찬원", "찬율", "찬일", "찬주", "찬준", "찬진", "찬하", "찬혁", "찬형",
	"찬홍", "찬환", "건희", "건호", "건모", "건민", "건영", "건용", "건일", "건주", "건하",
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

/** The next free name given the lower-cased names in use, cycling through the pool with 1, 2, 3, ... once exhausted. */
export function nextMemberName(taken: ReadonlySet<string>, pool: readonly string[] = MEMBER_NAMES_KO): string {
	const free = pool.find((n) => !taken.has(n.toLowerCase()));
	if (free) return free;
	for (let n = 1; ; n++) {
		for (const base of pool) {
			const candidate = `${base}${n}`;
			if (!taken.has(candidate.toLowerCase())) return candidate;
		}
	}
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
