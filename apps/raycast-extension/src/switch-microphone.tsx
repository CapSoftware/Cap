import {
	Action,
	ActionPanel,
	List,
	showToast,
	Toast,
} from "@raycast/api";
import { useState, useEffect } from "react";
import { openDeeplink } from "./utils";
import { execSync } from "node:child_process";

interface MicDevice {
	name: string;
	uid: string;
}

function listMicrophones(): MicDevice[] {
	try {
		const output = execSync(
			"system_profiler SPAudioDataType -json",
			{ encoding: "utf-8" },
		);
		const data = JSON.parse(output);
		const mics: MicDevice[] = [];

		for (const item of data.SPAudioDataType || []) {
			const items = item._items || [];
			for (const device of items) {
				const name = device._name || device.coreaudio_device_name || "";
				const isInput =
					(device.coreaudio_input_source || "").length > 0 ||
					(device.coreaudio_device_input || 0) > 0;
				if (isInput && name) {
					mics.push({ name, uid: device.coreaudio_device_uid || name });
				}
			}
		}
		return mics;
	} catch {
		return [];
	}
}

export default function Command() {
	const [mics, setMics] = useState<MicDevice[]>([]);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		setMics(listMicrophones());
		setLoading(false);
	}, []);

	async function handleSelect(mic: MicDevice) {
		const toast = await showToast({
			style: Toast.Style.Animated,
			title: `Switching to ${mic.name}...`,
		});

		await openDeeplink("switch_microphone", {
			mic_label: mic.name,
		});

		toast.style = Toast.Style.Success;
		toast.title = `Microphone: ${mic.name}`;
	}

	return (
		<List isLoading={loading} searchBarPlaceholder="Search microphones...">
			{mics.map((mic) => (
				<List.Item
					key={mic.uid}
					title={mic.name}
					actions={
						<ActionPanel>
							<Action
								title="Switch to Microphone"
								onAction={() => handleSelect(mic)}
							/>
						</ActionPanel>
					}
				/>
			))}
			<List.EmptyView
				title="No microphones found"
				description="Ensure a microphone is connected and accessible."
			/>
		</List>
	);
}
