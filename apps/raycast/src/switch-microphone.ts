import type { LaunchProps } from "@raycast/api";
import { fireAction } from "./deeplink";

interface Arguments {
	label?: string;
}

export default async function SwitchMicrophone(
	props: LaunchProps<{ arguments: Arguments }>,
): Promise<void> {
	const trimmed = props.arguments.label?.trim();
	const mic_label = trimmed && trimmed.length > 0 ? trimmed : null;
	const message = mic_label
		? `Cap microphone → ${mic_label}`
		: "Cap microphone cleared";
	await fireAction({ switch_microphone: { mic_label } }, message);
}
