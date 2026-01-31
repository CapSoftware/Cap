import { open } from "@raycast/api";

export default async function Command() {
  const action = { pause_recording: null };

  const url = `cap-desktop://action?value=${encodeURIComponent(JSON.stringify(action))}`;
  await open(url);
}
