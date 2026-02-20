import { LaunchProps } from "@raycast/api";
import { runDeepLinkAction } from "./lib/deeplink";

type CommandArguments = {
  cameraSelector?: string;
};

export default async function Command(props: LaunchProps<{ arguments: CommandArguments }>) {
  const cameraSelector = props.arguments.cameraSelector?.trim();
  await runDeepLinkAction(
    {
      switch_camera: {
        camera_selector: cameraSelector ? cameraSelector : null,
      },
    },
    "Cap camera switch requested",
  );
}
