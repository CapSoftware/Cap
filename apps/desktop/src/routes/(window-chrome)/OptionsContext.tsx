import { createContextProvider } from "@solid-primitives/context";
import { onCleanup } from "solid-js";
import { createOptionsQuery } from "~/utils/queries";
import { events } from "~/utils/tauri";

const [RecordingOptionsProvider, useRecordingOptionsContext] =
	createContextProvider(() => {
		const options = createOptionsQuery();
		const unlisten = events.onEscapePress.listen(() => {
			if (options.rawOptions.targetMode != null) {
				options.setOptions({
					targetMode: null,
					targetModeDismissal: "cancelled",
				});
			}
		});
		onCleanup(() => void unlisten.then((dispose) => dispose()));
		return options;
	});

export function useRecordingOptions() {
	return (
		useRecordingOptionsContext() ??
		(() => {
			throw new Error("useOptions must be used within an OptionsProvider");
		})()
	);
}

export { RecordingOptionsProvider };
