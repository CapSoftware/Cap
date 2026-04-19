import { open } from "@raycast/api";

export async function runCapDeeplink(body: Record<string, unknown>): Promise<void> {
  const value = encodeURIComponent(JSON.stringify(body));
  await open(`cap-desktop://action?value=${value}`);
}
