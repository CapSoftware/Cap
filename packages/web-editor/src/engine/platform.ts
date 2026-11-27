/// Apple keyboards use Command where everyone else uses Control, and their
/// trackpads report pinch zoom as a ctrl+wheel gesture.
export function isApplePlatform() {
	return /Mac|iPhone|iPad|iPod/i.test(
		navigator.platform || navigator.userAgent,
	);
}

export function isWindowsPlatform() {
	return /Win/i.test(navigator.platform || navigator.userAgent);
}
