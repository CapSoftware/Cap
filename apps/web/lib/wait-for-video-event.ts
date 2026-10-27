export function waitForVideoEvent(
	video: HTMLVideoElement,
	event: "loadedmetadata" | "seeked",
	start: () => void,
) {
	return new Promise<void>((resolve, reject) => {
		const cleanup = () => {
			video.removeEventListener(event, onReady);
			video.removeEventListener("error", onError);
		};
		const onReady = () => {
			cleanup();
			resolve();
		};
		const onError = () => {
			cleanup();
			reject(
				new Error("Your browser could not read this video for GIF conversion."),
			);
		};
		video.addEventListener(event, onReady);
		video.addEventListener("error", onError);
		try {
			start();
		} catch (error) {
			cleanup();
			reject(error);
		}
	});
}
