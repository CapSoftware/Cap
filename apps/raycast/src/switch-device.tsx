import { Action, ActionPanel, Form } from "@raycast/api";
import { setCamera, setMicrophone } from "./lib/deeplinks";

type Values = {
	deviceKind: "microphone" | "camera";
	value?: string;
	disable: boolean;
};

export default function Command() {
	return (
		<Form
			actions={
				<ActionPanel>
					<Action.SubmitForm
						title="Switch Device"
						onSubmit={(values: Values) => {
							const value = values.disable
								? null
								: values.value?.trim() || null;
							if (values.deviceKind === "microphone")
								return setMicrophone(value);
							return setCamera(value);
						}}
					/>
				</ActionPanel>
			}
		>
			<Form.Dropdown
				id="deviceKind"
				title="Device Type"
				defaultValue="microphone"
			>
				<Form.Dropdown.Item value="microphone" title="Microphone" />
				<Form.Dropdown.Item value="camera" title="Camera" />
			</Form.Dropdown>
			<Form.TextField id="value" title="Microphone Label or Camera Device ID" />
			<Form.Checkbox id="disable" label="Disable Input" />
		</Form>
	);
}
