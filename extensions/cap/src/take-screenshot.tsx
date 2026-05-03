import { LaunchProps, closeMainWindow, showHUD, showToast, Toast } from "@raycast/api";
import { runCapDeeplink } from "./deeplink";

type Args = { arguments: { target: string } };

export default async function main(props: LaunchProps<Args>) {
  const raw = props.arguments.target.trim();
  const idx = raw.indexOf(":");
  if (idx <= 0) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Use screen:Name or window:Name",
    });
    return;
  }
  const kind = raw.slice(0, idx).toLowerCase();
  const name = raw.slice(idx + 1).trim();
  if (!name) {
    await showToast({ style: Toast.Style.Failure, title: "Missing display/window name" });
    return;
  }
  const capture_mode =
    kind === "window"
      ? { window: name }
      : kind === "screen"
        ? { screen: name }
        : null;
  if (!capture_mode) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Prefix must be screen: or window:",
    });
    return;
  }
  await runCapDeeplink({ take_screenshot: { capture_mode } });
  await showHUD("Cap: screenshot");
  await closeMainWindow();
}
