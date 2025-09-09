import { createCurrentRecordingQuery } from "~/utils/queries";
import { useRecordingOptions } from "../OptionsContext";
import InfoPill from "./InfoPill";

export default function SystemAudio() {
	const { rawOptions, setOptions } = useRecordingOptions();
	const currentRecording = createCurrentRecordingQuery();

	return (
		<button
			onClick={() => {
				if (!rawOptions) return;
				setOptions({ captureSystemAudio: !rawOptions.captureSystemAudio });
			}}
			disabled={!!currentRecording.data}
			class="flex flex-row gap-2 items-center px-2 w-full h-9 rounded-lg transition-colors curosr-default disabled:opacity-70 bg-gray-3 disabled:text-gray-11 KSelect"
		>
			<IconPhMonitorBold class="text-gray-10 size-4" />
			<p class="flex-1 text-sm text-left truncate">
				{rawOptions.captureSystemAudio
					? "Record System Audio"
					: "No System Audio"}
			</p>
			<InfoPill variant={rawOptions.captureSystemAudio ? "blue" : "red"}>
				{rawOptions.captureSystemAudio ? "On" : "Off"}
			</InfoPill>
		</button>
	);
}
