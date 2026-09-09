export async function resolveInitialPlaybackUrl(
	url: PromiseLike<string | null> | undefined,
) {
	try {
		return await url;
	} catch {
		return null;
	}
}
