/** Given to sessions in order; the first one not taken by an active session is used. */
export const MEMBER_NAMES = [
	"철수", "미나", "제임스", "영희", "민준", "소피아", "지우", "에밀리", "하준", "루카",
	"서연", "토마스", "도윤", "서준", "예준", "시우", "주원", "지호", "지후", "준우",
	"현우", "도현", "건우", "우진", "승민", "유준", "재민", "태양", "선우", "은호",
	"정우", "시윤", "이안", "라온", "다온", "한결", "보람", "새롬", "하늘", "나래",
	"이든", "단우", "로운", "서진", "재윤", "민재", "성민", "동현", "영수", "상철",
	"지훈", "병철", "광수", "종호", "기태", "용준", "세훈", "수현", "현준", "윤호",
	"태민", "규민", "찬영", "서윤", "서아", "지아", "하윤", "하은", "지유", "수아",
	"지안", "윤서", "채원", "다은", "예은", "유나", "소율", "아린", "나은", "가은",
	"시은", "예린", "보라", "세아", "민서", "지민", "수빈", "유진", "은지", "혜진",
	"소연", "다인", "하린", "채은", "나연", "해인", "다현", "선아", "미소", "연우",
	"주아", "은서", "유리", "아영", "정아", "현아", "승아", "경미", "순희", "말숙",
	"길동", "영자", "리암", "노아", "올리버", "마이클", "다니엘", "사무엘", "벤", "잭",
	"헨리", "오스카", "레오", "맥스", "아담", "알렉스", "니콜라스", "가브리엘", "라파엘", "빅토르",
	"안토니오", "마르코", "파블로", "세바스찬", "클로이", "올리비아", "엠마", "리사", "안나", "줄리아",
	"사라", "로라", "한나", "그레이스", "아이린", "노라", "미아", "이사벨", "카밀라", "엘레나",
	"마리아", "비비안", "로즈", "릴리", "아이비", "스텔라", "루나", "조이", "재현", "민호",
	"성훈", "진우", "태준", "승현", "지원", "하람", "시현", "도훈", "준서", "예성",
	"은우", "지환", "동윤", "현서", "서현", "지수", "예지", "하영", "수진", "유경",
	"민아", "다영", "세린", "가영", "나윤", "소민", "유빈", "지은", "아윤", "예서",
	"채린", "하나", "별이", "다솔", "해솔", "마루", "보미", "솔이", "누리", "여울",
];

/** The next free name given the lower-cased names in use: the pool first, then 철수2, 철수3, ... */
export function nextMemberName(taken: ReadonlySet<string>): string {
	const free = MEMBER_NAMES.find((n) => !taken.has(n.toLowerCase()));
	if (free) return free;
	for (let n = 2; ; n++) if (!taken.has(`${MEMBER_NAMES[0]}${n}`.toLowerCase())) return `${MEMBER_NAMES[0]}${n}`;
}

/** The member a `@name` token starts with: the longest known name, not cut out of a longer ASCII word (Korean particles may follow: @미나랑). */
export function memberAt(token: string, names: readonly string[]): string | null {
	const low = token.toLowerCase();
	let best: string | null = null;
	for (const n of names) {
		const l = n.toLowerCase();
		if (!low.startsWith(l) || (best && n.length <= best.length)) continue;
		if (/[a-z0-9_-]$/.test(l) && /^[a-z0-9_-]/.test(low.slice(l.length))) continue;
		best = n;
	}
	return best;
}

/** Names written as `@name` in a message, limited to known members, in order of appearance, without repeats. */
export function mentionedMembers(text: string, names: readonly string[]): string[] {
	const out: string[] = [];
	for (const m of text.matchAll(/(?:^|\s)@(\S+)/g)) {
		const name = memberAt(m[1]!, names);
		if (name && !out.includes(name)) out.push(name);
	}
	return out;
}

/** Tells the model which sessions the user named, and how to reach them. */
export function memberHint(open: string, names: string[], purposes: Readonly<Record<string, string>> = {}): string {
	const list = names.map((n) => (purposes[n] ? `@${n} (${purposes[n]})` : `@${n}`)).join(", ");
	return `${open}The user mentioned ${list}: other sessions (agents) on this server. Use peer_send to give them work or ask them something (they run independently and see only what you send), and peer_read to look at what they said or did. Do not guess what they did.</pipaya-hint>`;
}
