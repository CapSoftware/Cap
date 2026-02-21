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
	createSetMicrophoneAction,
	type DeepLinkDevices,
	executeCapAction,
	executeCapActionWithResponse,
} from "./utils";

export default function Command() {
	const [microphones, setMicrophones] = useState<string[]>([]);
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
				setMicrophones(result.microphones);
			} else {
				showToast({
					style: Toast.Style.Failure,
					title: "Could not fetch microphones",
					message: "Make sure Cap is running",
				});
			}
			setIsLoading(false);
		}

		loadDevices();
	}, []);

	function selectAction(label: string | null, mic: string | null) {
		return (
			<ActionPanel>
				<Action
					title="Select Microphone"
					icon={Icon.Check}
					shortcut={{ modifiers: ["cmd"], key: "return" }}
					onAction={() =>
						executeCapAction(createSetMicrophoneAction(mic), {
							feedbackMessage: label ?? "Microphone disabled",
							feedbackType: "hud",
						})
					}
				/>
			</ActionPanel>
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
					actions={selectAction(null, null)}
				/>
			</List.Section>
			{microphones.length > 0 && (
				<List.Section
					title="Available Microphones"
					subtitle={`${microphones.length} found`}
				>
					{microphones.map((mic) => (
						<List.Item
							key={mic}
							title={mic}
							icon={{ source: Icon.Microphone, tintColor: Color.Blue }}
							accessories={[
								{ icon: Icon.ArrowRight, tooltip: "Set as active microphone" },
							]}
							actions={selectAction(`Microphone set to ${mic}`, mic)}
						/>
					))}
				</List.Section>
			)}
		</List>
	);
}
