import { Action, ActionPanel, Form } from "@raycast/api";
import { useId } from "react";
import { sendCapDeepLink } from "./deeplink";
import { type FormValues, getString } from "./form";

export default function Command() {
	const labelId = useId();

	async function onSubmit(values: FormValues) {
		const label = getString(values, labelId).trim();
		await sendCapDeepLink(
			"device/microphone",
			label ? { label } : { off: "true" },
		);
	}

	return (
		<Form
			actions={
				<ActionPanel>
					<Action.SubmitForm title="Switch Microphone" onSubmit={onSubmit} />
				</ActionPanel>
			}
		>
			<Form.Description text="Leave the field empty to disable microphone input." />
			<Form.TextField
				id={labelId}
				title="Microphone Label"
				placeholder="Exact microphone label shown in Cap"
			/>
		</Form>
	);
}
