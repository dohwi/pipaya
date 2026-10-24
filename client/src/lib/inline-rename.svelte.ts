/**
 * Renaming one row in place: which row is being edited and what has been typed so far. The sidebar has two of these
 * (conversations and terminals share one, split tabs have their own); each was an `id` + `draft` pair of runes with
 * start / commit / cancel written out twice.
 *
 * A `.svelte.ts` module: the two fields are runes, so a template that reads them updates when a method changes them.
 */
export class InlineRename {
	/** The id being renamed; null = nothing is */
	id = $state<string | null>(null);
	draft = $state("");

	start(id: string, current: string) {
		this.id = id;
		this.draft = current;
	}

	cancel() {
		this.id = null;
	}

	/**
	 * Finish: the id and the trimmed-nonempty draft to save, or null when nothing changed worth saving (nothing was being
	 * renamed, or the draft is blank). Always leaves editing mode. The draft itself is sent as typed, only a blank one is refused.
	 */
	commit(): { id: string; name: string } | null {
		const id = this.id;
		const name = this.draft;
		this.id = null;
		return id && name.trim() ? { id, name } : null;
	}

	/** Whether `id` is the row being edited */
	is(id: string): boolean {
		return this.id === id;
	}
}
