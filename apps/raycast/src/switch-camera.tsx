import { Action, ActionPanel, Form, showToast, Toast } from "@raycast/api";
import { useId, useState } from "react";
import { sendCapDeepLink } from "./deeplink";
import { type FormValues, getString } from "./form";

export default function Command() {
	const [cameraSource, setCameraSource] = useState("off");
	const cameraSourceId = useId();
	const cameraDeviceId = useId();
	const cameraModelId = useId();

	async function onSubmit(values: FormValues) {
		const selectedCameraSource = getString(values, cameraSourceId);
		const params: Record<string, string | undefined> = {};

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

		await sendCapDeepLink("device/camera", params);
	}

	return (
		<Form
			actions={
				<ActionPanel>
					<Action.SubmitForm title="Switch Camera" onSubmit={onSubmit} />
				</ActionPanel>
			}
		>
			<Form.Dropdown
				id={cameraSourceId}
				title="Camera Action"
				defaultValue="off"
				value={cameraSource}
				onChange={setCameraSource}
			>
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
