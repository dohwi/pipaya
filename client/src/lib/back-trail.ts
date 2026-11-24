/**
 * Conversation visit history shared by the phone back button, mouse Back/Forward buttons, and history shortcuts.
 *
 * A page is a conversation (or terminal) on a server. `visit` is told every page the screen shows; `back` walks
 * backward and `forward` walks forward again. The blank new-chat screen (`session: null`) is a page you can leave
 * (and step back from) but never a destination stored in the stacks.
 */
export type Page = { server: string; session: string | null };
export type NavDirection = "back" | "forward";

const same = (a: Page, b: Page) => a.server === b.server && a.session === b.session;

function pushUnique(stack: Page[], page: Page, max: number) {
	if (stack.length && same(stack[stack.length - 1]!, page)) return;
	stack.push(page);
	if (stack.length > max) stack.shift();
}

export class BackTrail {
	private backStack: Page[] = [];
	private forwardStack: Page[] = [];
	private current: Page | null = null;
	/** The page `back`/`forward` sent the user to, until the screen shows it (a server switch passes through a blank screen first). */
	private landing: Page | null = null;

	constructor(private readonly max = 50) {}

	get depth(): number {
		return this.backStack.length;
	}

	get forwardDepth(): number {
		return this.forwardStack.length;
	}

	visit(page: Page) {
		if (this.landing) {
			if (same(page, this.landing)) {
				this.landing = null;
				this.current = page;
				return;
			}
			if (page.server === this.landing.server && page.session === null) return; // on the way there
			this.landing = null;
		}
		if (this.current && same(this.current, page)) return;
		if (this.current?.session) pushUnique(this.backStack, this.current, this.max);
		this.forwardStack = [];
		this.current = page;
	}

	/** Step backward or forward, skipping pages that are gone (`usable` false) or already on screen; null when none is left. */
	private step(from: Page[], to: Page[], usable: (page: Page) => boolean): Page | null {
		while (from.length) {
			const page = from.pop()!;
			if ((this.current && same(this.current, page)) || !usable(page)) continue;
			if (this.current?.session) pushUnique(to, this.current, this.max);
			this.current = page;
			this.landing = page;
			return page;
		}
		return null;
	}

	/** The page to go back to, skipping ones that are gone (`usable` false) or already on screen; null when none is left. */
	back(usable: (page: Page) => boolean): Page | null {
		return this.step(this.backStack, this.forwardStack, usable);
	}

	/** The page to go forward to after stepping back; null when none is left. */
	forward(usable: (page: Page) => boolean): Page | null {
		return this.step(this.forwardStack, this.backStack, usable);
	}
}

/** Standard DOM mouse buttons for Back (XButton1 = 3) and Forward (XButton2 = 4). */
export function mouseNavDirection(button: number): NavDirection | null {
	if (button === 3) return "back";
	if (button === 4) return "forward";
	return null;
}

/** Browser Back/Forward keys sent by mouse macros and multimedia keyboards (`VK_BROWSER_BACK` / `VK_BROWSER_FORWARD`). */
export function browserNavKeyDirection(e: { key?: string; code?: string }): NavDirection | null {
	if (e.key === "BrowserBack" || e.code === "BrowserBack") return "back";
	if (e.key === "BrowserForward" || e.code === "BrowserForward") return "forward";
	return null;
}

type MouseButtonEvent = { button: number; preventDefault(): void };

/**
 * Turns mouse Back/Forward button presses (buttons 3 and 4) into one navigation call per click while always cancelling
 * the browser's own page-back/forward default on mousedown, mouseup, and auxclick.
 *
 * Navigating on `mousedown` feels instant and still works if the release happens outside the window; falling back to
 * `mouseup` covers drivers/webviews that deliver only the up event for XButton1/XButton2.
 */
export class MouseNavController {
	private handledDown = new Set<number>();

	constructor(private readonly onNavigate: (dir: NavDirection) => void) {}

	down = (e: MouseButtonEvent): boolean => {
		const dir = mouseNavDirection(e.button);
		if (!dir) return false;
		e.preventDefault();
		this.handledDown.add(e.button);
		this.onNavigate(dir);
		return true;
	};

	up = (e: MouseButtonEvent): boolean => {
		const dir = mouseNavDirection(e.button);
		if (!dir) return false;
		e.preventDefault();
		if (this.handledDown.delete(e.button)) return true;
		this.onNavigate(dir);
		return true;
	};

	auxClick = (e: MouseButtonEvent): boolean => {
		if (!mouseNavDirection(e.button)) return false;
		e.preventDefault();
		return true;
	};

	reset = () => {
		this.handledDown.clear();
	};
}
