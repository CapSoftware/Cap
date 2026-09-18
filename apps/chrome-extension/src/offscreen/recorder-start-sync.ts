export const observePairedRecorderStarts = (
	screenRecorder: MediaRecorder,
	cameraRecorder: MediaRecorder,
	onOffset: (offsetMs: number) => void,
	now: () => number = () => performance.now(),
) => {
	let screenStartedAt: number | null = null;
	let cameraStartedAt: number | null = null;
	const publishOffset = () => {
		if (screenStartedAt !== null && cameraStartedAt !== null) {
			onOffset(Math.round(cameraStartedAt - screenStartedAt));
		}
	};
	screenRecorder.addEventListener(
		"start",
		() => {
			screenStartedAt = now();
			publishOffset();
		},
		{ once: true },
	);
	cameraRecorder.addEventListener(
		"start",
		() => {
			cameraStartedAt = now();
			publishOffset();
		},
		{ once: true },
	);
};
