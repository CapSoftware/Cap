import type { LaunchProps } from "@raycast/api";
import { runCapAction } from "./deeplink";

type Arguments = {
	deviceId: string;
};

export default async function Command(
	props: LaunchProps<{ arguments: Arguments }>,
) {
	await runCapAction(
		{ set_camera: { camera: { DeviceID: props.arguments.deviceId } } },
		"Updated camera",
	);
}
