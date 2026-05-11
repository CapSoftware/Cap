import { Action, ActionPanel, Form } from "@raycast/api";
import { useId } from "react";
import { sendCapDeepLink } from "./deeplink";
import { type FormValues, getString } from "./form";

export default function Command() {
	const pageId = useId();

	async function onSubmit(values: FormValues) {
		await sendCapDeepLink("settings/open", {
			page: getString(values, pageId),
		});
	}

	return (
		<Form
			actions={
				<ActionPanel>
					<Action.SubmitForm title="Open Settings" onSubmit={onSubmit} />
				</ActionPanel>
			}
		>
			<Form.TextField
				id={pageId}
				title="Settings Page"
				placeholder="Optional page key, for example hotkeys"
			/>
		</Form>
	);
}
