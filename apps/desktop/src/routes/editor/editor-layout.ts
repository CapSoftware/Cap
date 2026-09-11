export const DEFAULT_TIMELINE_HEIGHT = 260;

export function editorVerticalLayout(available: number, preferred: number) {
	const height = Math.max(0, available);
	const minPlayerHeight = 320 * Math.min(1, height / 560);
	return {
		minPlayerHeight,
		timelineHeight: Math.round(
			Math.min(Math.max(0, preferred), Math.floor(height - minPlayerHeight)),
		),
	};
}
