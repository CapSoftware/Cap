import { showHUD, open } from "@raycast/api";

export default async function Command() {
  try {
    const action = "resume_recording";
    const url = `cap-desktop://action?value="${action}"`;
    await open(url);
    await showHUD("▶️ Resuming Cap recording");
  } catch (error) {
    await showHUD("❌ Failed to resume recording");
    console.error(error);
  }
}
