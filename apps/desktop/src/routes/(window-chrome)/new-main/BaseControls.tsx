import { onMount } from "solid-js";
import CameraSelect from "./CameraSelect";
import MicrophoneSelect from "./MicrophoneSelect";
import SystemAudio from "./SystemAudio";
import { useSystemHardwareOptions } from "./useSystemHardwareOptions";
import { useRecordingOptions } from "../OptionsContext";
import { createCameraMutation } from "~/utils/queries";
import { createMutation } from "@tanstack/solid-query";
import { commands } from "~/utils/tauri";

export function BaseControls() {
	const { rawOptions, setOptions } = useRecordingOptions();
	const { cameras, mics, options } = useSystemHardwareOptions();

	const setCamera = createCameraMutation();
	const setMicInput = createMutation(() => ({
		mutationFn: async (name: string | null) => {
			await commands.setMicInput(name);
			setOptions("micName", name);
		},
	}));

	onMount(() => {
		if (rawOptions.cameraID && "ModelID" in rawOptions.cameraID)
			setCamera.mutate({ ModelID: rawOptions.cameraID.ModelID });
		else if (rawOptions.cameraID && "DeviceID" in rawOptions.cameraID)
			setCamera.mutate({ DeviceID: rawOptions.cameraID.DeviceID });
		else setCamera.mutate(null);
	});

	return (
		<div class="space-x-2 grid grid-cols-2">
			<CameraSelect
				disabled={cameras.isPending}
				options={cameras.data ?? []}
				value={options.camera() ?? null}
				onChange={(c) => {
					if (!c) setCamera.mutate(null);
					else if (c.model_id) setCamera.mutate({ ModelID: c.model_id });
					else setCamera.mutate({ DeviceID: c.device_id });
				}}
			/>
			<MicrophoneSelect
				disabled={mics.isPending}
				options={mics.isPending ? [] : (mics.data ?? [])}
				value={
					mics.isPending ? rawOptions.micName : (options.micName() ?? null)
				}
				onChange={(v) => setMicInput.mutate(v)}
			/>
			{/*<SystemAudio />*/}
		</div>
	);
}
