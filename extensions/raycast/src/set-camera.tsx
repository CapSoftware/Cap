import { Action, ActionPanel, Form, showToast, Toast } from "@raycast/api";
import { deviceId, modelId, runCapAction } from "./cap";

type Values = {
	type: "device_id" | "model_id";
	id: string;
};

export default function Command() {
	async function handleSubmit(values: Values) {
		const id = values.id.trim();
		if (!id) {
			await showToast({
				style: Toast.Style.Failure,
				title: "Enter a camera ID",
			});
			return;
		}

		await runCapAction(
			{
				set_camera_input: {
					id: values.type === "device_id" ? deviceId(id) : modelId(id),
				},
			},
			"Switching camera",
		);
	}

	return (
		<Form
			actions={
				<ActionPanel>
					<Action.SubmitForm title="Set Camera" onSubmit={handleSubmit} />
				</ActionPanel>
			}
		>
			<Form.Dropdown id="type" title="ID Type" defaultValue="device_id">
				<Form.Dropdown.Item value="device_id" title="Device ID" />
				<Form.Dropdown.Item value="model_id" title="Model ID" />
			</Form.Dropdown>
			<Form.TextField
				id="id"
				title="Camera ID"
				placeholder="Camera device or model ID"
			/>
		</Form>
	);
}
