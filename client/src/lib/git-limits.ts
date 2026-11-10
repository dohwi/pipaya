/**
 * How much of a repository the git panel shows. The server enforces its own caps (`GIT_LIMITS` in
 * server/src/git-routes.ts); these are what the client asks for and says, kept equal to them by a test.
 */
export const GIT_LIMITS = {
	/** Commits per page of the graph, and the most the server will give in total. */
	commitsPage: 50,
	commitsMax: 300,
	/** Branches in the picker: the server cuts and says so. */
	branches: 60,
} as const;
