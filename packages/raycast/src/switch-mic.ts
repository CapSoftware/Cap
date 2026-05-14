import { triggerAction } from "./utils";
import { showHUD } from "@raycast/api";

interface Arguments {
  mic: string;
}

export default async function Command(props: { arguments: Arguments }) {
  const { mic } = props.arguments;
  await triggerAction({ switch_mic: { mic_label: mic } });
  await showHUD(`Switching Microphone to ${mic}`);
}
