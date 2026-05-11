import {
	Action,
	ActionPanel,
	Form,
	Icon,
	showToast,
	Toast,
} from "@raycast/api";
import { openDeeplink } from "./utils";

export default function Command() {
	async function handleSubmit(values: {
		captureType: string;
		screenOrWindow: string;
		mode: string;
		mic: string;
		systemAudio: boolean;
	}) {
		try {
			const toast = await showToast({
				style: Toast.Style.Animated,
				title: "Starting recording...",
			});

			let captureMode;
			if (values.captureType === "window") {
				captureMode = { window: values.screenOrWindow };
			} else {
				captureMode = { screen: values.screenOrWindow };
			}

			await openDeeplink("start_recording", {
				capture_mode: captureMode,
				camera: null,
				mic_label: values.mic || null,
				capture_system_audio: values.systemAudio,
				mode: values.mode,
			});

			toast.style = Toast.Style.Success;
			toast.title = "Recording started";
		} catch {
			await showToast({
				style: Toast.Style.Failure,
				title: "Failed to start recording",
			});
		}
	}

	return (
		<Form
			actions={
				<ActionPanel>
					<Action.SubmitForm
						icon={Icon.Video}
						title="Start Recording"
						onSubmit={handleSubmit}
					/>
				</ActionPanel>
			}
		>
			<Form.Dropdown id="mode" title="Recording Mode" defaultValue="studio">
				<Form.Dropdown.Item value="studio" title="Studio" />
				<Form.Dropdown.Item value="instant" title="Instant" />
			</Form.Dropdown>
			<Form.Dropdown
				id="captureType"
				title="Capture Type"
				defaultValue="screen"
			>
				<Form.Dropdown.Item value="screen" title="Screen" />
				<Form.Dropdown.Item value="window" title="Window" />
			</Form.Dropdown>
			<Form.TextField
				id="screenOrWindow"
				title="Display / Window Name"
				placeholder="Enter display or window name"
			/>
			<Form.TextField
				id="mic"
				title="Microphone (optional)"
				placeholder="Enter microphone label"
			/>
			<Form.Checkbox
				id="systemAudio"
				title="Capture System Audio"
				label="Include system audio"
				defaultValue={false}
			/>
		</Form>
	);
}
