import { Action, ActionPanel, List, showToast, Toast } from "@raycast/api";
import { useState, useEffect } from "react";
import { openDeeplink } from "./utils";
import { promisify } from "node:util";
import { exec } from "node:child_process";

const execAsync = promisify(exec);

interface MicDevice {
	name: string;
	uid: string;
}

async function listMicrophones(): Promise<MicDevice[]> {
	const { stdout } = await execAsync(
		"system_profiler SPAudioDataType -json",
		{ encoding: "utf-8" },
	);
	const data = JSON.parse(stdout);
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
}

export default function Command() {
	const [mics, setMics] = useState<MicDevice[]>([]);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		listMicrophones()
			.then(setMics)
			.catch(() => setMics([]))
			.finally(() => setLoading(false));
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
