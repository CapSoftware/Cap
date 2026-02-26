import {
	Action,
	ActionPanel,
	Color,
	Detail,
	Icon,
	List,
	LocalStorage,
} from "@raycast/api";
import { useEffect, useState } from "react";
import {
	CAP_URL_SCHEME,
	capNotInstalled,
	createListDevicesAction,
	createSetMicrophoneAction,
	type DeepLinkDevices,
	executeCapAction,
	executeCapActionWithResponse,
} from "./utils";

const RECENT_MIC_KEY = "recent-microphone";

function EmptyState({
	capNotRunning,
	onOpenCap,
}: {
	capNotRunning: boolean;
	onOpenCap: () => void;
}) {
	const markdown = capNotRunning
		? "## Cap Not Running\n\nPlease open Cap to switch microphones."
		: "## No Microphones Found\n\nCould not find any microphones connected to your system.";

	return (
		<Detail
			markdown={markdown}
			actions={
				<ActionPanel>
					{capNotRunning ? (
						<Action
							title="Open Cap"
							icon={Icon.AppWindow}
							onAction={onOpenCap}
						/>
					) : (
						<Action
							title="Retry"
							icon={Icon.RotateClockwise}
							onAction={() => {}}
						/>
					)}
				</ActionPanel>
			}
		/>
	);
}

export default function Command() {
	const [microphones, setMicrophones] = useState<string[]>([]);
	const [isLoading, setIsLoading] = useState(true);
	const [capNotRunning, setCapNotRunning] = useState(false);
	const [recentMic, setRecentMic] = useState<string | null>(null);

	useEffect(() => {
		async function loadRecent() {
			const stored = await LocalStorage.getItem<string>(RECENT_MIC_KEY);
			setRecentMic(stored ?? null);
		}
		loadRecent();
	}, []);

	useEffect(() => {
		async function loadDevices() {
			const notInstalled = await capNotInstalled();
			if (notInstalled) {
				setCapNotRunning(true);
				setIsLoading(false);
				return;
			}

			const result = await executeCapActionWithResponse<DeepLinkDevices>(
				createListDevicesAction(),
			);

			if (result && result.microphones.length > 0) {
				setMicrophones(result.microphones);
			} else if (!result || result.microphones.length === 0) {
				setCapNotRunning(true);
			}
			setIsLoading(false);
		}

		loadDevices();
	}, []);

	async function handleSelectMicrophone(
		micLabel: string | null,
		micName: string | null,
	) {
		if (micLabel) {
			await LocalStorage.setItem(RECENT_MIC_KEY, micLabel);
		}
		await executeCapAction(createSetMicrophoneAction(micLabel), {
			feedbackMessage: micName ? `🎤 ${micName}` : "🎤 Microphone off",
			feedbackType: "hud",
		});
	}

	function handleOpenCap() {
		import("node:child_process").then(({ execFileSync }) => {
			execFileSync("open", [CAP_URL_SCHEME]);
		});
	}

	if (!isLoading && capNotRunning) {
		return (
			<EmptyState capNotRunning={capNotRunning} onOpenCap={handleOpenCap} />
		);
	}

	return (
		<List isLoading={isLoading} searchBarPlaceholder="Search microphones...">
			<List.Section title="Disable">
				<List.Item
					title="No Microphone"
					subtitle="Mute all audio input"
					icon={{
						source: Icon.MicrophoneDisabled,
						tintColor: Color.SecondaryText,
					}}
					actions={
						<ActionPanel>
							<Action
								title="Mute Microphone"
								icon={Icon.Check}
								shortcut={{ modifiers: ["cmd"], key: "return" }}
								onAction={() => handleSelectMicrophone(null, null)}
							/>
						</ActionPanel>
					}
				/>
			</List.Section>
			{microphones.length > 0 && (
				<List.Section
					title="Available Microphones"
					subtitle={`${microphones.length} found`}
				>
					{microphones.map((mic) => {
						const isRecent = mic === recentMic;
						return (
							<List.Item
								key={mic}
								title={mic}
								icon={{
									source: Icon.Microphone,
									tintColor: isRecent ? Color.Green : Color.Blue,
								}}
								accessories={
									isRecent
										? [{ text: "Recent", icon: Icon.Star }]
										: [{ icon: Icon.ArrowRight }]
								}
								actions={
									<ActionPanel>
										<Action
											title="Select Microphone"
											icon={Icon.Check}
											shortcut={{ modifiers: ["cmd"], key: "return" }}
											onAction={() => handleSelectMicrophone(mic, mic)}
										/>
									</ActionPanel>
								}
							/>
						);
					})}
				</List.Section>
			)}
		</List>
	);
}
