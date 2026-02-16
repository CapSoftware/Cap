import { closeMainWindow, showToast, Toast } from "@raycast/api";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export default async function Command() {
  await closeMainWindow();

  await showToast({
    style: Toast.Style.Animated,
    title: "Opening Cap...",
  });

  try {
    await execFileAsync("open", ["cap-desktop://"]);

    await showToast({
      style: Toast.Style.Success,
      title: "Cap opened",
      message: "Start a recording in Cap, then use the other commands to control it.",
    });
  } catch (error) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Failed to open Cap",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
