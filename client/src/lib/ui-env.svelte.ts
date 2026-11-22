import type { ActionId } from "./keys";

/**
 * Runtime hooks injected by the app shell so leaf `components/ui/*` primitives never import `store.svelte.ts`.
 * Defaults are safe fallbacks for standalone tests and isolated mounts.
 */
export interface UiEnv {
	dark: () => boolean;
	closeBinding: (action: ActionId) => string | undefined;
}

const env: UiEnv = {
	dark: () => false,
	closeBinding: () => undefined,
};

export function configureUiEnv(next: Partial<UiEnv>) {
	if (next.dark) env.dark = next.dark;
	if (next.closeBinding) env.closeBinding = next.closeBinding;
}

export const uiEnv: Readonly<UiEnv> = {
	dark: () => env.dark(),
	closeBinding: (action) => env.closeBinding(action),
};
