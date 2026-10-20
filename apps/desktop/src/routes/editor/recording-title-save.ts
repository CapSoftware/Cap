export function createRecordingTitleSave(options: {
	initialName: string;
	getDraft: () => string;
	resetDraft: (name: string) => void;
	save: (name: string) => Promise<void>;
}) {
	let persistedName = options.initialName;
	let saveInFlight: Promise<void> | undefined;

	const saveDraft = async () => {
		while (true) {
			const trimmed = options.getDraft().trim();
			if (trimmed.length < 5 || trimmed.length > 100) {
				options.resetDraft(persistedName);
				return;
			}
			if (trimmed === persistedName) return;

			await options.save(trimmed);
			persistedName = trimmed;
			if (options.getDraft().trim() === persistedName) return;
		}
	};

	return () => {
		if (saveInFlight) return saveInFlight;
		const save = saveDraft();
		const tracked = save.finally(() => {
			if (saveInFlight === tracked) saveInFlight = undefined;
		});
		saveInFlight = tracked;
		return tracked;
	};
}
