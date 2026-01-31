import { simpleCapAction } from "./utils";

export default async function Command() {
  await simpleCapAction("toggle_pause_recording");
}
