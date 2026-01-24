import { open, showHUD, closeMainWindow } from "@raycast/api";

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
    try {
        await closeMainWindow();
        // If action is a string, it's a unit variant (e.g. "stop_recording")
        // If it's an object, it's a struct variant (e.g. { "start_recording": ... })
        const jsonValue = JSON.stringify(action);
        const url = `cap-desktop://action?value=${encodeURIComponent(jsonValue)}`;
        await open(url);
        await showHUD(hudMessage);
    } catch (error) {
        console.error(error);
        await showHUD("Failed to connect to Cap");
    }
}
