export function getActiveCaptionText(
	activeCues: TextTrackCueList | null | undefined,
): string {
	if (!activeCues?.length) {
		return "";
	}

	let selectedCue: VTTCue | null = null;

	for (let index = 0; index < activeCues.length; index++) {
		const cue = activeCues.item(index) as VTTCue | null;
		if (cue && (!selectedCue || cue.startTime >= selectedCue.startTime)) {
			selectedCue = cue;
		}
	}

	return selectedCue?.text.replace(/<[^>]*>/g, "") ?? "";
}
