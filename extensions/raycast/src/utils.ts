import { open, showHUD } from "@raycast/api";

export async function executeCapAction(action: string, params?: Record<string, string>) {
  let url = `cap-desktop://${action}`;
  if (params) {
    const query = new URLSearchParams(params).toString();
    url += `?${query}`;
  }

  try {
    await open(url);
    await showHUD(`Triggered Cap: ${action}`);
  } catch (error) {
    console.error(error);
  }
}

export async function executeJsonAction(actionName: string, value: any) {
  const payload = JSON.stringify({ [actionName]: value });
  const url = `cap-desktop://action?value=${encodeURIComponent(payload)}`;

  try {
    await open(url);
    await showHUD(`Triggered Cap Action: ${actionName}`);
  } catch (error) {
    console.error(error);
  }
}
