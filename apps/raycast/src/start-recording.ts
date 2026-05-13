import { LaunchProps, closeMainWindow, showHUD } from "@raycast/api";

import { sendActionWithPayload } from "./utils";

interface StartRecordingArguments {
  captureMode?: string;
  captureName?: string;
}

export default async function Command(props: LaunchProps<{ arguments: StartRecordingArguments }>) {
  await closeMainWindow();

  const captureMode = props.arguments.captureMode || "screen";
  const captureName = props.arguments.captureName || undefined;

  await sendActionWithPayload("start_recording", {
    capture_mode: { [captureMode]: captureName },
    camera: null,
    mic_label: null,
    capture_system_audio: false,
    mode: "Instant",
  });

  await showHUD("Cap: Recording started");
}
