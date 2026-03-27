import { open } from "@raycast/api";

export async function sendDeepLink(action: object) {
  const value = encodeURIComponent(JSON.stringify(action));
  const url = `cap://action?value=${value}`;
  await open(url);
}
