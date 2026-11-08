/** What a row shares with its title while it is renamed in place (set by `RowShell`, read by `RowTitle`) */
export const ROW_RENAME = Symbol("row-rename");
export interface RowRename {
	readonly active: boolean;
	readonly draft: string;
	ondraft: (v: string) => void;
	oncommit: () => void;
	oncancel: () => void;
	readonly maxlength?: number;
}
