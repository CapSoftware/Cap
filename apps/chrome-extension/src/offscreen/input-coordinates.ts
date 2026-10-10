export function mapTabPointerToVideo(
	x: number,
	y: number,
	viewportWidth: number,
	viewportHeight: number,
	videoWidth: number,
	videoHeight: number,
) {
	if (
		![x, y, viewportWidth, viewportHeight, videoWidth, videoHeight].every(
			Number.isFinite,
		) ||
		viewportWidth <= 0 ||
		viewportHeight <= 0 ||
		videoWidth <= 0 ||
		videoHeight <= 0
	) {
		return null;
	}
	const scale = Math.min(
		videoWidth / viewportWidth,
		videoHeight / viewportHeight,
	);
	const contentWidth = viewportWidth * scale;
	const contentHeight = viewportHeight * scale;
	return {
		x:
			(videoWidth - contentWidth) / (2 * videoWidth) +
			(x * contentWidth) / videoWidth,
		y:
			(videoHeight - contentHeight) / (2 * videoHeight) +
			(y * contentHeight) / videoHeight,
	};
}
