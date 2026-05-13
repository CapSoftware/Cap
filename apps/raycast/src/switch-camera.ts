import { LaunchProps } from "@raycast/api";

import { cameraIdentifier, triggerCapAction } from "./lib/cap";

type SwitchCameraArguments = {
	identifierType: "device" | "model";
	cameraIdentifier: string;
};

export default async function Command(
	props: LaunchProps<{ arguments: SwitchCameraArguments }>,
) {
	const { identifierType, cameraIdentifier: identifier } = props.arguments;

	await triggerCapAction(
		{
			set_camera: {
				camera: cameraIdentifier(identifierType, identifier),
			},
		},
		"Cap camera switch request sent",
	);
}
