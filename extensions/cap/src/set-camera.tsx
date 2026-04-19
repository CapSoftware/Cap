import { LaunchProps, closeMainWindow, showHUD, showToast, Toast } from "@raycast/api";
import { runCapDeeplink } from "./deeplink";

type Args = { arguments: { cameraJson: string } };

export default async function main(props: LaunchProps<Args>) {
  const raw = props.arguments.cameraJson?.trim() ?? "";
  let camera: unknown = null;
  if (raw.length > 0) {
    try {
      camera = JSON.parse(raw) as unknown;
    } catch {
      await showToast({
        style: Toast.Style.Failure,
        title: "Invalid JSON",
        message: "Paste device_or_model_id from raycast-device-cache.json",
      });
      return;
    }
  }
  await runCapDeeplink({ set_camera: { camera } });
  await showHUD("Cap: set camera");
  await closeMainWindow();
}
