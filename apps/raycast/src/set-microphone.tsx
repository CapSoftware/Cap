import { LaunchProps, open, showHUD } from "@raycast/api";
import { buildDeeplinkUrl } from "./utils";

interface Arguments {
  microphone: string;
}

export default async function Command(props: LaunchProps<{ arguments: Arguments }>) {
  const mic = props.arguments.microphone?.trim() || null;

  const url = buildDeeplinkUrl({
    set_microphone: {
      mic_label: mic,
    },
  });

  await open(url);
  await showHUD(mic ? `Switching microphone to ${mic}` : "Disabling microphone");
}
