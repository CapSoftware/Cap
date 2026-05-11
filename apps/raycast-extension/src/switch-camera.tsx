import { Action, ActionPanel, List, showToast, Toast } from "@raycast/api";
import { useState, useEffect } from "react";
import { openDeeplink } from "./utils";
import { promisify } from "node:util";
import { exec } from "node:child_process";

const execAsync = promisify(exec);

interface CameraDevice {
	name: string;
	modelId: string;
}

async function listCameras(): Promise<CameraDevice[]> {
	const { stdout } = await execAsync(
		"system_profiler SPCameraDataType -json",
		{ encoding: "utf-8" },
	);
	const data = JSON.parse(stdout);
	const cameras: CameraDevice[] = [];

	for (const item of data.SPCameraDataType || []) {
		const items = item._items || [];
		for (const device of items) {
			const name = device._name || "";
			const modelId = device.spcamera_model_id || device._name || "";
			if (name) {
				cameras.push({ name, modelId });
			}
		}
	}
	return cameras;
}

export default function Command() {
	const [cameras, setCameras] = useState<CameraDevice[]>([]);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		listCameras()
			.then(setCameras)
			.catch(() => setCameras([]))
			.finally(() => setLoading(false));
	}, []);

	async function handleSelect(camera: CameraDevice) {
		const toast = await showToast({
			style: Toast.Style.Animated,
			title: `Switching to ${camera.name}...`,
		});

		await openDeeplink("switch_camera", {
			camera_id: { ModelID: camera.modelId },
		});

		toast.style = Toast.Style.Success;
		toast.title = `Camera: ${camera.name}`;
	}

	return (
		<List isLoading={loading} searchBarPlaceholder="Search cameras...">
			{cameras.map((camera) => (
				<List.Item
					key={camera.modelId}
					title={camera.name}
					actions={
						<ActionPanel>
							<Action
								title="Switch to Camera"
								onAction={() => handleSelect(camera)}
							/>
						</ActionPanel>
					}
				/>
			))}
			<List.EmptyView
				title="No cameras found"
				description="Ensure a camera is connected and accessible."
			/>
		</List>
	);
}
