import { LaunchProps } from "@raycast/api";
import { runDeepLinkAction } from "./lib/deeplink";

type CommandArguments = {
  micLabel?: string;
};

export default async function Command(props: LaunchProps<{ arguments: CommandArguments }>) {
  const micLabel = props.arguments.micLabel?.trim();
  await runDeepLinkAction(
    {
      switch_microphone: {
        mic_label: micLabel ? micLabel : null,
      },
    },
    "Cap microphone switch requested",
  );
}
