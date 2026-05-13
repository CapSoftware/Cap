import { open } from "@raycast/api";

const DEEP_LINK_BASE = "cap-desktop://action";

export async function sendAction(action: string) {
  const value = JSON.stringify(action);
  const url = `${DEEP_LINK_BASE}?value=${encodeURIComponent(value)}`;
  await open(url);
}

export async function sendActionWithPayload(action: string, payload: Record<string, unknown>) {
  const value = JSON.stringify({ [action]: payload });
  const url = `${DEEP_LINK_BASE}?value=${encodeURIComponent(value)}`;
  await open(url);
}
