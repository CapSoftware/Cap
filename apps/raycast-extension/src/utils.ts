import { open } from "@raycast/api";

export function buildDeeplink(action: string, value: unknown): string {
  let json: string;
  if (value === null || value === undefined) {
    json = JSON.stringify(action);
  } else {
    json = JSON.stringify({ [action]: value });
  }
  return `cap-desktop://action?value=${encodeURIComponent(json)}`;
}

export async function openDeeplink(action: string, value: unknown): Promise<void> {
  const url = buildDeeplink(action, value);
  await open(url);
}
