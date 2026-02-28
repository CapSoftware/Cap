import {
	Action,
	ActionPanel,
	closeMainWindow,
	Form,
	open,
	showHUD,
} from "@raycast/api";

interface Values {
	id: string;
}

export default function Command() {
	async function handleSubmit(values: Values) {
		const id = values.id.trim();
		const url = id
			? `cap://switch-camera?id=${encodeURIComponent(id)}`
			: "cap://switch-camera";

		await closeMainWindow();
		try {
			await open(url);
			await showHUD(id ? `Switching camera to: ${id}` : "Disabling camera");
		} catch {
			await showHUD("Failed to open Cap");
		}
	}

	return (
		<Form
			actions={
				<ActionPanel>
					<Action.SubmitForm title="Switch Camera" onSubmit={handleSubmit} />
				</ActionPanel>
			}
		>
			<Form.TextField
				id="id"
				title="Camera Device ID"
				placeholder="Paste the camera device_id (leave blank to disable)"
				autoFocus
			/>
		</Form>
	);
}
