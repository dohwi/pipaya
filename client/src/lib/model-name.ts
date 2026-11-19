/**
 * What the app shows for a model: the name the model is registered under on the server ("Fast model", "내 에코 모델",
 * the display name the owner gave it in the connection settings), found by the exact provider and id; the bare id when
 * no registered model matches (a provider since removed, a model renamed upstream), so a model never loses its name.
 */
type Named = { provider: string; id: string; name?: string };

export function modelDisplayName(models: readonly Named[], provider: string | undefined, id: string | undefined): string {
	if (!id) return "";
	const name = models.find((m) => m.provider === provider && m.id === id)?.name?.trim();
	return name || id;
}

/** `provider/model` → its two parts (the id may hold more slashes: `router/vendor/model-x`). A bare id has no provider. */
export function splitModelRef(ref: string): { provider: string | undefined; id: string } {
	const cut = ref.indexOf("/");
	return cut < 0 ? { provider: undefined, id: ref } : { provider: ref.slice(0, cut), id: ref.slice(cut + 1) };
}

/** The display name of a model written as `provider/model` (a role file's `model`, a delegate call, a saved setting). */
export function modelRefName(models: readonly Named[], ref: string | undefined | null): string {
	if (!ref) return "";
	const { provider, id } = splitModelRef(ref);
	return modelDisplayName(models, provider, id);
}

/** A connection's display name ("Fake Cloud"), else its id. */
export function providerDisplayName(providers: readonly { id: string; name?: string }[], id: string | undefined): string {
	if (!id) return "";
	return providers.find((p) => p.id === id)?.name?.trim() || id;
}

/** The brand mark the owner picked for a model in the connection settings, if any (else the logo is guessed from the id). */
export function modelIcon(models: readonly { provider: string; id: string; icon?: string }[], provider: string | undefined, id: string | undefined): string | undefined {
	return id ? models.find((m) => m.provider === provider && m.id === id)?.icon : undefined;
}
