import {
	Action,
	ActionPanel,
	Color,
	Detail,
	Icon,
	Keyboard,
	showHUD,
} from "@raycast/api";
import { useEffect, useState } from "react";
import {
	capNotInstalled,
	createGetStatusAction,
	createRestartRecordingAction,
	createStartRecordingAction,
	createStopRecordingAction,
	createTogglePauseAction,
	executeCapAction,
	executeCapActionWithResponse,
	type RecordingStatus,
} from "./utils";

function formatDuration(seconds: number): string {
	const mins = Math.floor(seconds / 60);
	const secs = seconds % 60;
	if (mins < 60) {
		return `${mins}:${secs.toString().padStart(2, "0")}`;
	}
	const hours = Math.floor(mins / 60);
	const remainingMins = mins % 60;
	return `${hours}:${remainingMins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}

export default function Command() {
	const [status, setStatus] = useState<RecordingStatus | null>(null);
	const [isLoading, setIsLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [elapsedSeconds, setElapsedSeconds] = useState(0);
	const [recordingStartTime, setRecordingStartTime] = useState<number | null>(
		null,
	);

	async function fetchStatus() {
		setIsLoading(true);
		setError(null);

		if (await capNotInstalled(false)) {
			setError("Cap is not installed");
			setIsLoading(false);
			return;
		}

		const result = await executeCapActionWithResponse<RecordingStatus>(
			createGetStatusAction(),
		);

		if (result) {
			setStatus(result);
			// Start tracking elapsed time when recording starts
			if (result.is_recording && !result.is_paused) {
				if (!recordingStartTime) {
					setRecordingStartTime(Date.now());
				}
			} else {
				setRecordingStartTime(null);
				setElapsedSeconds(0);
			}
		} else {
			setError("Could not get status from Cap. Make sure the app is running.");
		}
		setIsLoading(false);
	}

	// Auto-refresh and elapsed time tracking
	useEffect(() => {
		fetchStatus();

		const refreshInterval = setInterval(() => {
			fetchStatus();
		}, 3000);

		return () => clearInterval(refreshInterval);
	}, []);

	// Update elapsed time every second when recording
	useEffect(() => {
		if (!recordingStartTime) return;

		const timerInterval = setInterval(() => {
			const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
			setElapsedSeconds(elapsed);
		}, 1000);

		return () => clearInterval(timerInterval);
	}, [recordingStartTime]);

	const statusConfig = status?.is_recording
		? status.is_paused
			? {
					value: "Paused",
					color: Color.Yellow,
					icon: Icon.Pause,
					tooltip: "Recording is paused",
				}
			: {
					value: "Recording",
					color: Color.Red,
					icon: Icon.Video,
					tooltip: "Currently recording",
				}
		: {
				value: "Idle",
				color: Color.SecondaryText,
				icon: Icon.CircleDisabled,
				tooltip: "No active recording",
			};

	const modeText = status?.recording_mode
		? status.recording_mode.charAt(0).toUpperCase() +
			status.recording_mode.slice(1)
		: undefined;

	// Build markdown with status info
	let markdown = "# Cap Recording Status\n\n";
	if (error) {
		markdown = `# Error\n\n${error}`;
	} else if (status?.is_recording) {
		const durationText = status.is_paused
			? "⏸ Paused"
			: `⏱ ${formatDuration(elapsedSeconds)}`;
		markdown += `## ${statusConfig.icon === Icon.Video ? "🔴" : "⏸️"} ${statusConfig.value}\n\n`;
		markdown += `**Duration:** ${durationText}\n\n`;
		markdown += `**Mode:** ${modeText ?? "Unknown"}\n\n`;
		markdown += status.is_paused
			? "_Recording is paused. Press Resume to continue._"
			: "_Recording in progress. Use the controls below to manage._";
	} else {
		markdown += "## No Active Recording\n\n";
		markdown += "Start a new recording from the actions below.";
	}

	const metadata =
		!error && status ? (
			<Detail.Metadata>
				<Detail.Metadata.TagList title="Status">
					<Detail.Metadata.TagList.Item
						text={statusConfig.value}
						color={statusConfig.color}
					/>
				</Detail.Metadata.TagList>
				{status.is_recording && (
					<Detail.Metadata.Label
						title="Duration"
						text={formatDuration(elapsedSeconds)}
						icon={Icon.Clock}
					/>
				)}
				{modeText && <Detail.Metadata.Label title="Mode" text={modeText} />}
				<Detail.Metadata.Separator />
				<Detail.Metadata.Label
					title="Auto-refresh"
					text="Every 3s"
					icon={Icon.ArrowClockwise}
				/>
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
								shortcut={{ modifiers: ["cmd", "shift"], key: "p" }}
								onAction={async () => {
									await executeCapAction(createTogglePauseAction(), {
										closeWindow: false,
									});
									await showHUD(status?.is_paused ? "▶️ Resumed" : "⏸️ Paused");
									setTimeout(fetchStatus, 500);
								}}
							/>
							<Action
								title="Restart Recording"
								icon={Icon.RotateAntiClockwise}
								shortcut={{ modifiers: ["cmd", "shift"], key: "r" }}
								onAction={async () => {
									await executeCapAction(createRestartRecordingAction(), {
										closeWindow: false,
									});
									await showHUD("🔄 Restarted recording");
									setRecordingStartTime(Date.now());
									setElapsedSeconds(0);
									setTimeout(fetchStatus, 500);
								}}
							/>
							<Action
								title="Stop Recording"
								icon={Icon.Stop}
								style={Action.Style.Destructive}
								shortcut={Keyboard.Shortcut.Common.Remove}
								onAction={async () => {
									await executeCapAction(createStopRecordingAction(), {
										closeWindow: false,
									});
									await showHUD("⏹️ Recording stopped");
									setRecordingStartTime(null);
									setElapsedSeconds(0);
									setTimeout(fetchStatus, 500);
								}}
							/>
						</ActionPanel.Section>
					)}
					{!error && !status?.is_recording && (
						<ActionPanel.Section title="Quick Start">
							<Action
								title="Start Instant Recording"
								icon={Icon.Video}
								shortcut={{ modifiers: ["cmd", "shift"], key: "i" }}
								onAction={async () => {
									await executeCapAction(
										createStartRecordingAction(
											{ screen: "Primary" },
											"instant",
										),
										{ closeWindow: false },
									);
									await showHUD("🎬 Started instant recording");
									setTimeout(fetchStatus, 500);
								}}
							/>
							<Action
								title="Start Studio Recording"
								icon={Icon.Camera}
								shortcut={{ modifiers: ["cmd", "shift"], key: "s" }}
								onAction={async () => {
									await executeCapAction(
										createStartRecordingAction({ screen: "Primary" }, "studio"),
										{ closeWindow: false },
									);
									await showHUD("🎬 Started studio recording");
									setTimeout(fetchStatus, 500);
								}}
							/>
						</ActionPanel.Section>
					)}
				</ActionPanel>
			}
		/>
	);
}
