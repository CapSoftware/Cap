import { Color, Icon, MenuBarExtra, open, showHUD } from "@raycast/api";
import { useEffect, useState } from "react";
import {
	capNotInstalled,
	createGetStatusAction,
	createPauseRecordingAction,
	createRestartRecordingAction,
	createResumeRecordingAction,
	createStartRecordingAction,
	createStopRecordingAction,
	createTakeScreenshotAction,
	executeCapAction,
	executeCapActionWithResponse,
	type RecordingStatus,
} from "./utils";

export default function Command() {
	const [status, setStatus] = useState<RecordingStatus | null>(null);
	const [isLoading, setIsLoading] = useState(true);
	const [isInstalled, setIsInstalled] = useState<boolean | null>(null);

	async function fetchStatus() {
		if (await capNotInstalled(false)) {
			setIsInstalled(false);
			setIsLoading(false);
			return;
		}
		setIsInstalled(true);

		const result = await executeCapActionWithResponse<RecordingStatus>(
			createGetStatusAction(),
		);
		setStatus(result);
		setIsLoading(false);
	}

	useEffect(() => {
		fetchStatus();
		const interval = setInterval(fetchStatus, 3000);
		return () => clearInterval(interval);
	}, []);

	if (isInstalled === false) {
		return (
			<MenuBarExtra
				isLoading={isLoading}
				icon={Icon.VideoDisabled}
				title="Cap"
				tooltip="Cap is not installed"
			>
				<MenuBarExtra.Section>
					<MenuBarExtra.Item
						title="Download Cap"
						icon={Icon.Download}
						onAction={() => open("https://cap.so/download")}
					/>
				</MenuBarExtra.Section>
			</MenuBarExtra>
		);
	}

	const isRecording = status?.is_recording ?? false;
	const isPaused = status?.is_paused ?? false;
	const recordingMode = status?.recording_mode;

	// Determine icon and title based on state
	let icon = Icon.Video;
	let tintColor: Color | undefined;
	let title = "Cap";
	let tooltip = "Cap Recording Control";

	if (isRecording) {
		if (isPaused) {
			icon = Icon.Pause;
			tintColor = Color.Yellow;
			title = "Paused";
			tooltip = `Recording paused (${recordingMode})`;
		} else {
			icon = Icon.Video;
			tintColor = Color.Red;
			title = "REC";
			tooltip = `Recording in progress (${recordingMode})`;
		}
	}

	return (
		<MenuBarExtra
			isLoading={isLoading}
			icon={{ source: icon, tintColor }}
			title={title}
			tooltip={tooltip}
		>
			{isRecording ? (
				<>
					<MenuBarExtra.Section title="Recording Status">
						<MenuBarExtra.Item
							title={`Status: ${isPaused ? "Paused" : "Recording"}`}
							icon={isPaused ? Icon.Pause : Icon.Video}
						/>
						{recordingMode && (
							<MenuBarExtra.Item
								title={`Mode: ${recordingMode.charAt(0).toUpperCase() + recordingMode.slice(1)}`}
								icon={Icon.Gear}
							/>
						)}
					</MenuBarExtra.Section>
					<MenuBarExtra.Section>
						<MenuBarExtra.Item
							title={isPaused ? "Resume Recording" : "Pause Recording"}
							icon={isPaused ? Icon.Play : Icon.Pause}
							onAction={async () => {
								if (isPaused) {
									await executeCapAction(createResumeRecordingAction(), {
										closeWindow: false,
									});
									await showHUD("▶️ Resumed");
								} else {
									await executeCapAction(createPauseRecordingAction(), {
										closeWindow: false,
									});
									await showHUD("⏸️ Paused");
								}
								setTimeout(fetchStatus, 500);
							}}
						/>
						<MenuBarExtra.Item
							title="Restart Recording"
							icon={Icon.RotateAntiClockwise}
							onAction={async () => {
								await executeCapAction(createRestartRecordingAction(), {
									closeWindow: false,
								});
								await showHUD("🔄 Restarted");
								setTimeout(fetchStatus, 500);
							}}
						/>
					</MenuBarExtra.Section>
					<MenuBarExtra.Section>
						<MenuBarExtra.Item
							title="Stop Recording"
							icon={{ source: Icon.Stop, tintColor: Color.Red }}
							onAction={async () => {
								await executeCapAction(createStopRecordingAction(), {
									closeWindow: false,
								});
								await showHUD("⏹️ Stopped");
								setTimeout(fetchStatus, 500);
							}}
						/>
					</MenuBarExtra.Section>
				</>
			) : (
				<>
					<MenuBarExtra.Section title="Start Recording">
						<MenuBarExtra.Item
							title="Instant Record"
							icon={Icon.Video}
							onAction={async () => {
								await executeCapAction(
									createStartRecordingAction({ screen: "Primary" }, "instant"),
									{ closeWindow: false },
								);
								await showHUD("🎬 Instant recording started");
								setTimeout(fetchStatus, 500);
							}}
						/>
						<MenuBarExtra.Item
							title="Studio Record"
							icon={Icon.Camera}
							onAction={async () => {
								await executeCapAction(
									createStartRecordingAction({ screen: "Primary" }, "studio"),
									{ closeWindow: false },
								);
								await showHUD("🎬 Studio recording started");
								setTimeout(fetchStatus, 500);
							}}
						/>
					</MenuBarExtra.Section>
					<MenuBarExtra.Section>
						<MenuBarExtra.Item
							title="Take Screenshot"
							icon={Icon.Camera}
							onAction={async () => {
								await executeCapAction(
									createTakeScreenshotAction({ screen: "Primary" }),
									{ closeWindow: false },
								);
								await showHUD("📸 Screenshot taken");
							}}
						/>
					</MenuBarExtra.Section>
				</>
			)}
			<MenuBarExtra.Section>
				<MenuBarExtra.Item
					title="Open Cap"
					icon={Icon.AppWindow}
					onAction={() => open("cap-desktop://")}
				/>
			</MenuBarExtra.Section>
		</MenuBarExtra>
	);
}
