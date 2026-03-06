import { dispatchSimpleAction } from "./utils";

export default async function Command() {
  await dispatchSimpleAction("toggle_pause_recording");
}
