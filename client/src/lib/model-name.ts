/**
 * What a reply shows for the model that wrote it: the name the model is registered under on the server ("Fast model",
 * "내 에코 모델"), found by the exact provider and id the reply recorded; the bare id when no registered model matches
 * (a provider since removed, a model renamed upstream), so a reply never loses its model.
 */
export function modelDisplayName(
	models: readonly { provider: string; id: string; name?: string }[],
	provider: string | undefined,
	id: string | undefined,
): string {
	if (!id) return "";
	const name = models.find((m) => m.provider === provider && m.id === id)?.name?.trim();
	return name || id;
}
