import { open, showHUD } from "@raycast/api";

export async function triggerAction(action: any) {
  try {
    const json = JSON.stringify(action);
    const url = `cap-desktop://action?value=${encodeURIComponent(json)}`;
    await open(url);
  } catch (error) {
    await showHUD("Failed to trigger Cap action");
    console.error(error);
  }
}
