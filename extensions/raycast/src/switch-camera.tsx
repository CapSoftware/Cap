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
	createSetCameraAction,
	type DeepLinkCamera,
	type DeepLinkDevices,
	executeCapAction,
	executeCapActionWithResponse,
} from "./utils";

const RECENT_CAMERA_KEY = "recent-camera";

function EmptyState({
	capNotRunning,
	onOpenCap,
}: {
	capNotRunning: boolean;
	onOpenCap: () => void;
}) {
	const markdown = capNotRunning
		? "## Cap Not Running\n\nPlease open Cap to switch cameras."
		: "## No Cameras Found\n\nCould not find any cameras connected to your system.";

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
	const [cameras, setCameras] = useState<DeepLinkCamera[]>([]);
	const [isLoading, setIsLoading] = useState(true);
	const [capNotRunning, setCapNotRunning] = useState(false);
	const [recentCamera, setRecentCamera] = useState<string | null>(null);

	useEffect(() => {
		async function loadRecent() {
			const stored = await LocalStorage.getItem<string>(RECENT_CAMERA_KEY);
			setRecentCamera(stored ?? null);
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

			if (result && result.cameras.length > 0) {
				setCameras(result.cameras);
			} else if (!result || result.cameras.length === 0) {
				setCapNotRunning(true);
			}
			setIsLoading(false);
		}

		loadDevices();
	}, []);

	async function handleSelectCamera(
		cameraId: string | null,
		cameraName: string | null,
	) {
		if (cameraId) {
			await LocalStorage.setItem(RECENT_CAMERA_KEY, cameraId);
		}
		await executeCapAction(
			createSetCameraAction(cameraId ? { DeviceID: cameraId } : null),
			{
				feedbackMessage: cameraName ? `📹 ${cameraName}` : "📹 Camera off",
				feedbackType: "hud",
			},
		);
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
		<List isLoading={isLoading} searchBarPlaceholder="Search cameras...">
			<List.Section title="Disable">
				<List.Item
					title="No Camera"
					subtitle="Hide camera overlay"
					icon={{ source: Icon.VideoDisabled, tintColor: Color.SecondaryText }}
					actions={
						<ActionPanel>
							<Action
								title="Disable Camera"
								icon={Icon.Check}
								shortcut={{ modifiers: ["cmd"], key: "return" }}
								onAction={() => handleSelectCamera(null, null)}
							/>
						</ActionPanel>
					}
				/>
			</List.Section>
			{cameras.length > 0 && (
				<List.Section
					title="Available Cameras"
					subtitle={`${cameras.length} found`}
				>
					{cameras.map((camera) => {
						const isRecent = camera.id === recentCamera;
						return (
							<List.Item
								key={camera.id}
								title={camera.name}
								icon={{
									source: Icon.Video,
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
											title="Select Camera"
											icon={Icon.Check}
											shortcut={{ modifiers: ["cmd"], key: "return" }}
											onAction={() =>
												handleSelectCamera(camera.id, camera.name)
											}
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
