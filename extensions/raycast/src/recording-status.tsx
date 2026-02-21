import {
	Action,
	ActionPanel,
	Color,
	Detail,
	Icon,
	Keyboard,
} from "@raycast/api";
import { useEffect, useState } from "react";
import {
	capNotInstalled,
	createGetStatusAction,
	createRestartRecordingAction,
	createStopRecordingAction,
	createTogglePauseAction,
	executeCapAction,
	executeCapActionWithResponse,
	type RecordingStatus,
} from "./utils";

export default function Command() {
	const [status, setStatus] = useState<RecordingStatus | null>(null);
	const [isLoading, setIsLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	async function fetchStatus() {
		setIsLoading(true);
		setError(null);

		if (await capNotInstalled()) {
			setError("Cap is not installed");
			setIsLoading(false);
			return;
		}

		const result = await executeCapActionWithResponse<RecordingStatus>(
			createGetStatusAction(),
		);

		if (result) {
			setStatus(result);
		} else {
			setError("Could not get status from Cap. Make sure the app is running.");
		}
		setIsLoading(false);
	}

	useEffect(() => {
		fetchStatus();
	}, []);

	const statusTag = status?.is_recording
		? status.is_paused
			? { value: "Paused", color: Color.Yellow }
			: { value: "Recording", color: Color.Red }
		: { value: "Idle", color: Color.SecondaryText };

	const modeText = status?.recording_mode
		? status.recording_mode.charAt(0).toUpperCase() +
			status.recording_mode.slice(1)
		: undefined;

	const markdown = error ? `# Error\n\n${error}` : "# Cap Recording Status";

	const metadata =
		!error && status ? (
			<Detail.Metadata>
				<Detail.Metadata.TagList title="Status">
					<Detail.Metadata.TagList.Item
						text={statusTag.value}
						color={statusTag.color}
					/>
				</Detail.Metadata.TagList>
				{modeText && <Detail.Metadata.Label title="Mode" text={modeText} />}
				{status.is_recording && (
					<>
						<Detail.Metadata.Separator />
						<Detail.Metadata.Label
							title="Paused"
							text={status.is_paused ? "Yes" : "No"}
						/>
					</>
				)}
			</Detail.Metadata>
		) : undefined;

	return (
		<Detail
			isLoading={isLoading}
			markdown={markdown}
			metadata={metadata}
			actions={
				<ActionPanel>
					<Action
						title="Refresh"
						icon={Icon.ArrowClockwise}
						shortcut={{ modifiers: ["cmd"], key: "r" }}
						onAction={fetchStatus}
					/>
					{!error && status?.is_recording && (
						<ActionPanel.Section title="Recording Controls">
							<Action
								title={
									status.is_paused ? "Resume Recording" : "Pause Recording"
								}
								icon={status.is_paused ? Icon.Play : Icon.Pause}
								shortcut={{ modifiers: ["cmd"], key: "p" }}
								onAction={async () => {
									await executeCapAction(createTogglePauseAction(), {
										feedbackMessage: status.is_paused
											? "Resuming..."
											: "Pausing...",
										feedbackType: "hud",
									});
									setTimeout(fetchStatus, 500);
								}}
							/>
							<Action
								title="Restart Recording"
								icon={Icon.RotateAntiClockwise}
								shortcut={{ modifiers: ["cmd", "shift"], key: "r" }}
								onAction={async () => {
									await executeCapAction(createRestartRecordingAction(), {
										feedbackMessage: "Restarting recording...",
										feedbackType: "hud",
									});
									setTimeout(fetchStatus, 1000);
								}}
							/>
							<Action
								title="Stop Recording"
								icon={Icon.Stop}
								style={Action.Style.Destructive}
								shortcut={Keyboard.Shortcut.Common.Remove}
								onAction={async () => {
									await executeCapAction(createStopRecordingAction(), {
										feedbackMessage: "Stopping recording...",
										feedbackType: "hud",
									});
									setTimeout(fetchStatus, 1000);
								}}
							/>
						</ActionPanel.Section>
					)}
				</ActionPanel>
			}
		/>
	);
}
