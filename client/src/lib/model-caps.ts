import { msg } from "./i18n";
import type { IconName } from "../components/Icon.svelte";

/** What a model can do, as the four tags every model list shows. */
export type CapKey = "chat" | "reasoning" | "vision" | "image";

export interface Cap {
	key: CapKey;
	icon: IconName;
	/** Short word shown next to the icon */
	label: string;
	/** What the word means, for the tooltip */
	hint: string;
}

const CAPS: Record<CapKey, Cap> = {
	chat: { key: "chat", icon: "chat", label: msg("채팅"), hint: msg("글로 대화하고 도구를 쓸 수 있습니다") },
	reasoning: { key: "reasoning", icon: "brain", label: msg("추론"), hint: msg("답하기 전에 깊이 생각합니다") },
	vision: { key: "vision", icon: "image", label: msg("이미지 읽기"), hint: msg("보낸 이미지를 읽고 이해합니다") },
	image: { key: "image", icon: "sparkles", label: msg("이미지 생성·편집"), hint: msg("그림을 만들고, 이전 그림을 고칩니다") },
};

/** The abilities of a model, in display order. An image-generation model draws pictures instead of chatting, so it has no chat or reasoning. */
export function capsOf(m: { reasoning: boolean; vision: boolean; imageGeneration?: boolean }): Cap[] {
	if (m.imageGeneration) return [CAPS.image, ...(m.vision ? [CAPS.vision] : [])];
	return [CAPS.chat, ...(m.reasoning ? [CAPS.reasoning] : []), ...(m.vision ? [CAPS.vision] : [])];
}
