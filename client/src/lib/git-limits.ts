/**
 * How much of a repository the git panel shows. The server enforces its own caps (`GIT_LIMITS` in
 * server/src/git-routes.ts); these are what the client asks for and says, kept equal to them.
 */
export const GIT_LIMITS = {
	/** Commits per page of the graph, and the most the server will give in total. */
	commitsPage: 50,
	commitsMax: 300,
	/** Changed files, branches in the picker and files of one commit: the server cuts and says so. */
	files: 1000,
	branches: 60,
	commitFiles: 100,
	/** Rows of the changed-files list shown before it scrolls. */
	filesVisible: 8,
} as const;
