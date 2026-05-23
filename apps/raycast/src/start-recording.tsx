import { Action, ActionPanel, Form } from "@raycast/api";
import { startRecording } from "./lib/deeplinks";

type Values = {
	targetKind: "screen" | "window";
	targetName: string;
	mode: "studio" | "instant";
	micLabel?: string;
	cameraDeviceId?: string;
	captureSystemAudio: boolean;
};

export default function Command() {
	return (
		<Form
			actions={
				<ActionPanel>
					<Action.SubmitForm
						title="Start Recording"
						onSubmit={(values: Values) =>
							startRecording({
								target: {
									kind: values.targetKind,
									name: values.targetName,
								},
								mode: values.mode,
								micLabel: values.micLabel,
								cameraDeviceId: values.cameraDeviceId,
								captureSystemAudio: values.captureSystemAudio,
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
			<Form.Dropdown id="mode" title="Mode" defaultValue="studio">
				<Form.Dropdown.Item value="studio" title="Studio" />
				<Form.Dropdown.Item value="instant" title="Instant" />
			</Form.Dropdown>
			<Form.TextField id="micLabel" title="Microphone Label" />
			<Form.TextField id="cameraDeviceId" title="Camera Device ID" />
			<Form.Checkbox id="captureSystemAudio" label="Capture System Audio" />
		</Form>
	);
}
