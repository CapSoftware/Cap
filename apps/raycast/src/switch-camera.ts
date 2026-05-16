import type { LaunchProps } from "@raycast/api";
import { fireAction } from "./deeplink";

interface Arguments {
	identifier?: string;
}

const DEVICE_ID_PATTERN = /^[0-9a-fA-F-]{8,}$/;

export default async function SwitchCamera(
	props: LaunchProps<{ arguments: Arguments }>,
): Promise<void> {
	const trimmed = props.arguments.identifier?.trim();
	if (!trimmed || trimmed.length === 0) {
		await fireAction({ switch_camera: { camera: null } }, "Cap camera cleared");
		return;
	}
	const camera = DEVICE_ID_PATTERN.test(trimmed)
		? { DeviceID: trimmed }
		: { ModelID: trimmed };
	await fireAction({ switch_camera: { camera } }, `Cap camera → ${trimmed}`);
}
