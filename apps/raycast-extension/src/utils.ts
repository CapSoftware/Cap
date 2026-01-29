import { closeMainWindow, open, showHUD } from "@raycast/api";

type CapAction = string | Record<string, unknown>;

export async function sendCapCommand(action: CapAction, hudMessage: string): Promise<void> {
  try {
    await closeMainWindow();
    const url = `cap-desktop://action?value=${encodeURIComponent(JSON.stringify(action))}`;
    await open(url);
    await showHUD(hudMessage);
  } catch (error) {
    console.error(error);
    await showHUD("Failed to connect to Cap");
  }
}
