/** Extensions whose job the server does itself now. An old copy left in an extensions folder is not loaded: it would replace the built-in tool and add every hint twice. */
export const RETIRED_EXTENSIONS: ReadonlySet<string> = new Set(["ask-user", "peer-tools"]);
