import {
	Action,
	ActionPanel,
	Color,
	Icon,
	List,
	showToast,
	Toast,
} from "@raycast/api";
import { useEffect, useState } from "react";
import {
	capNotInstalled,
	createListDevicesAction,
	createSetCameraAction,
	type DeepLinkCamera,
	type DeepLinkDevices,
	executeCapAction,
	executeCapActionWithResponse,
} from "./utils";

export default function Command() {
	const [cameras, setCameras] = useState<DeepLinkCamera[]>([]);
	const [isLoading, setIsLoading] = useState(true);

	useEffect(() => {
		async function loadDevices() {
			if (await capNotInstalled()) {
				setIsLoading(false);
				return;
			}

			const result = await executeCapActionWithResponse<DeepLinkDevices>(
				createListDevicesAction(),
			);

			if (result) {
				setCameras(result.cameras);
			} else {
				showToast({
					style: Toast.Style.Failure,
					title: "Could not fetch cameras",
					message: "Make sure Cap is running",
				});
			}
			setIsLoading(false);
		}

		loadDevices();
	}, []);

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
								title="Select Camera"
								icon={Icon.Check}
								shortcut={{ modifiers: ["cmd"], key: "return" }}
								onAction={() =>
									executeCapAction(createSetCameraAction(null), {
										feedbackMessage: "Camera disabled",
										feedbackType: "hud",
									})
								}
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
					{cameras.map((camera) => (
						<List.Item
							key={camera.id}
							title={camera.name}
							icon={{ source: Icon.Video, tintColor: Color.Blue }}
							accessories={[
								{ icon: Icon.ArrowRight, tooltip: "Set as active camera" },
							]}
							actions={
								<ActionPanel>
									<Action
										title="Select Camera"
										icon={Icon.Check}
										shortcut={{ modifiers: ["cmd"], key: "return" }}
										onAction={() =>
											executeCapAction(
												createSetCameraAction({ DeviceID: camera.id }),
												{
													feedbackMessage: `Camera set to ${camera.name}`,
													feedbackType: "hud",
												},
											)
										}
									/>
								</ActionPanel>
							}
						/>
					))}
				</List.Section>
			)}
		</List>
	);
}
