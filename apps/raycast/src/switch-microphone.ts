import { LaunchProps } from "@raycast/api";

import { triggerCapAction } from "./lib/cap";

type SwitchMicrophoneArguments = {
	micLabel: string;
};

export default async function Command(
	props: LaunchProps<{ arguments: SwitchMicrophoneArguments }>,
) {
	const { micLabel } = props.arguments;

	await triggerCapAction(
		{
			set_microphone: {
				mic_label: micLabel,
			},
		},
		"Cap microphone switch request sent",
	);
}
