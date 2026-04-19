import { LaunchProps, closeMainWindow, showHUD } from "@raycast/api";
import { runCapDeeplink } from "./deeplink";

type Args = { arguments: { micLabel: string } };

export default async function main(props: LaunchProps<Args>) {
  const label = props.arguments.micLabel?.trim();
  await runCapDeeplink({
    set_microphone: { mic_label: label ? label : null },
  });
  await showHUD("Cap: set microphone");
  await closeMainWindow();
}
