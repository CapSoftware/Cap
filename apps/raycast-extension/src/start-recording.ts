import { showHUD, open } from "@raycast/api";

export default async function Command() {
  await open("cap-desktop://action?value=%7B%22start_recording%22%3A%7B%22capture_mode%22%3A%7B%22screen%22%3A%22default%22%7D%2C%22camera%22%3Anull%2C%22mic_label%22%3Anull%2C%22capture_system_audio%22%3Afalse%2C%22mode%22%3A%22instant%22%7D%7D");
  await showHUD("Cap: Recording started");
}
