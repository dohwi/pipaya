/**
 * The phone's back button / back swipe walks back through the conversations the user opened, before it leaves the app.
 *
 * A page is a conversation on a server. `visit` is told every page the screen shows; `back` hands out the one before it.
 * The blank new-chat screen (`session: null`) is a page you can leave but not one to come back to: it is never stored.
 */
export type Page = { server: string; session: string | null };

const same = (a: Page, b: Page) => a.server === b.server && a.session === b.session;

export class BackTrail {
	private stack: Page[] = [];
	private current: Page | null = null;
	/** The page `back` sent the user to, until the screen shows it (a server switch passes through a blank screen first). */
	private landing: Page | null = null;

	constructor(private readonly max = 50) {}

	get depth(): number {
		return this.stack.length;
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
		if (this.current?.session && !(this.stack.length && same(this.stack[this.stack.length - 1]!, this.current))) {
			this.stack.push(this.current);
			if (this.stack.length > this.max) this.stack.shift();
		}
		this.current = page;
	}

	/** The page to go back to, skipping ones that are gone (`usable` false) or already on screen; null when none is left. */
	back(usable: (page: Page) => boolean): Page | null {
		while (this.stack.length) {
			const page = this.stack.pop()!;
			if ((this.current && same(this.current, page)) || !usable(page)) continue;
			this.current = page;
			this.landing = page;
			return page;
		}
		return null;
	}
}
