import { Action, ActionPanel, Form } from "@raycast/api";
import { screenshot } from "./lib/deeplinks";

type Values = {
	targetKind: "screen" | "window";
	targetName: string;
};

export default function Command() {
	return (
		<Form
			actions={
				<ActionPanel>
					<Action.SubmitForm
						title="Take Screenshot"
						onSubmit={(values: Values) =>
							screenshot({
								kind: values.targetKind,
								name: values.targetName,
							})
						}
					/>
				</ActionPanel>
			}
		>
			<Form.Dropdown id="targetKind" title="Target Type" defaultValue="screen">
				<Form.Dropdown.Item value="screen" title="Screen" />
				<Form.Dropdown.Item value="window" title="Window" />
			</Form.Dropdown>
			<Form.TextField id="targetName" title="Target Name" />
		</Form>
	);
}
