import { Action, ActionPanel, Form, showToast, Toast } from "@raycast/api";
import { runCapAction } from "./cap";

type Values = {
	label: string;
};

export default function Command() {
	async function handleSubmit(values: Values) {
		const label = values.label.trim();
		if (!label) {
			await showToast({
				style: Toast.Style.Failure,
				title: "Enter a microphone label",
			});
			return;
		}

		await runCapAction({ set_mic_input: { label } }, "Switching microphone");
	}

	return (
		<Form
			actions={
				<ActionPanel>
					<Action.SubmitForm title="Set Microphone" onSubmit={handleSubmit} />
				</ActionPanel>
			}
		>
			<Form.TextField
				id="label"
				title="Microphone Label"
				placeholder="MacBook Pro Microphone"
			/>
		</Form>
	);
}
