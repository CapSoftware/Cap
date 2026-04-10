import { Action, ActionPanel, Form, showToast, Toast } from "@raycast/api";
import { useId, useState } from "react";
import { sendCapDeepLink } from "./deeplink";
import { type FormValues, getString, getStringArray } from "./form";

export default function Command() {
	const [cameraSource, setCameraSource] = useState("keep");
	const modeId = useId();
	const captureTypeId = useId();
	const targetId = useId();
	const captureSystemAudioId = useId();
	const micLabelId = useId();
	const cameraSourceId = useId();
	const cameraDeviceId = useId();
	const cameraModelId = useId();

	async function onSubmit(values: FormValues) {
		const target = getString(values, targetId).trim();

		if (!target) {
			await showToast({
				style: Toast.Style.Failure,
				title: "Target is required",
				message: "Use the exact screen or window name shown in Cap.",
			});
			return;
		}

		const selectedCameraSource = getString(values, cameraSourceId);
		const params: Record<string, string | undefined> = {
			mode: getString(values, modeId),
			capture_type: getString(values, captureTypeId),
			target,
			capture_system_audio: getStringArray(
				values,
				captureSystemAudioId,
			).includes("enabled")
				? "true"
				: "false",
			mic_label: getString(values, micLabelId),
		};

		if (selectedCameraSource === "device_id") {
			const deviceId = getString(values, cameraDeviceId).trim();
			if (!deviceId) {
				await showToast({
					style: Toast.Style.Failure,
					title: "Camera device ID is required",
				});
				return;
			}
			params.device_id = deviceId;
		}

		if (selectedCameraSource === "model_id") {
			const modelId = getString(values, cameraModelId).trim();
			if (!modelId) {
				await showToast({
					style: Toast.Style.Failure,
					title: "Camera model ID is required",
					message: "Use the VID:PID format expected by Cap.",
				});
				return;
			}
			params.model_id = modelId;
		}

		if (selectedCameraSource === "off") {
			params.off = "true";
		}

		await sendCapDeepLink("record/start", params);
	}

	return (
		<Form
			actions={
				<ActionPanel>
					<Action.SubmitForm title="Start Recording" onSubmit={onSubmit} />
				</ActionPanel>
			}
		>
			<Form.Dropdown id={modeId} title="Mode" defaultValue="studio">
				<Form.Dropdown.Item value="studio" title="Studio" />
				<Form.Dropdown.Item value="instant" title="Instant" />
			</Form.Dropdown>
			<Form.Dropdown
				id={captureTypeId}
				title="Capture Type"
				defaultValue="screen"
			>
				<Form.Dropdown.Item value="screen" title="Screen" />
				<Form.Dropdown.Item value="window" title="Window" />
			</Form.Dropdown>
			<Form.TextField
				id={targetId}
				title="Target"
				placeholder="Exact screen or window name shown in Cap"
			/>
			<Form.TagPicker id={captureSystemAudioId} title="System Audio">
				<Form.TagPicker.Item value="enabled" title="Capture system audio" />
			</Form.TagPicker>
			<Form.TextField
				id={micLabelId}
				title="Microphone Label"
				placeholder="Optional exact microphone label shown in Cap"
			/>
			<Form.Dropdown
				id={cameraSourceId}
				title="Camera"
				defaultValue="keep"
				value={cameraSource}
				onChange={setCameraSource}
			>
				<Form.Dropdown.Item value="keep" title="Keep current camera" />
				<Form.Dropdown.Item value="off" title="Disable camera" />
				<Form.Dropdown.Item value="device_id" title="Set by device ID" />
				<Form.Dropdown.Item value="model_id" title="Set by model ID" />
			</Form.Dropdown>
			{cameraSource === "device_id" ? (
				<Form.TextField
					id={cameraDeviceId}
					title="Camera Device ID"
					placeholder="Exact camera device ID expected by Cap"
				/>
			) : null}
			{cameraSource === "model_id" ? (
				<Form.TextField
					id={cameraModelId}
					title="Camera Model ID"
					placeholder="VID:PID"
				/>
			) : null}
		</Form>
	);
}
