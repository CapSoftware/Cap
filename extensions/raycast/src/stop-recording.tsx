import { open } from "@raycast/api";

export default async function Command() {
  const value = JSON.stringify({ StopRecording: {} });
  await open(`cap://action?value=${encodeURIComponent(value)}`);
}
