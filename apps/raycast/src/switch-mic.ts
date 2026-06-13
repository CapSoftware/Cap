import { LaunchProps } from "@raycast/api";
import { sendCapCommand } from "./utils";

export default async function Command(props: LaunchProps<{ arguments: { micLabel: string } }>) {
  await sendCapCommand("switch_microphone", {
    mic_label: props.arguments.micLabel === "none" ? null : props.arguments.micLabel
  });
}
