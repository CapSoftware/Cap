import type { LaunchProps } from "@raycast/api";
import { runCapAction } from "./deeplink";

type Arguments = {
	micLabel: string;
};

export default async function Command(
	props: LaunchProps<{ arguments: Arguments }>,
) {
	await runCapAction(
		{ set_microphone: { mic_label: props.arguments.micLabel } },
		"Updated microphone",
	);
}
