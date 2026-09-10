export type RequestHandoffPlayback = (
	playing: boolean,
	seconds?: number,
) => Promise<boolean> | undefined;

export function routeEditorPlaybackIntent(
	request: RequestHandoffPlayback,
	intent: { playing: boolean; seconds?: number },
	ordinary: () => Promise<void>,
): Promise<boolean> {
	const pending = request(intent.playing, intent.seconds);
	if (pending) return pending;
	return ordinary().then(() => true);
}
