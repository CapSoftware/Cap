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
		screen: string;
		mode: string;
		mic: string;
		systemAudio: boolean;
	}) {
		const toast = await showToast({
			style: Toast.Style.Animated,
			title: "Starting recording...",
		});

		const captureMode =
			values.screen === "window"
				? { window: values.screen }
				: { screen: values.screen };

		await openDeeplink("start_recording", {
			capture_mode: captureMode,
			camera: null,
			mic_label: values.mic || null,
			capture_system_audio: values.systemAudio,
			mode: values.mode,
		});

		toast.style = Toast.Style.Success;
		toast.title = "Recording started";
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
			<Form.Dropdown id="mode" title="Recording Mode" defaultValue="Studio">
				<Form.Dropdown.Item value="Studio" title="Studio" />
				<Form.Dropdown.Item value="Instant" title="Instant" />
			</Form.Dropdown>
			<Form.TextField
				id="screen"
				title="Screen / Window"
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
