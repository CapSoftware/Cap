import { fireSimpleAction } from "./lib/cap";

export default async function Command() {
  await fireSimpleAction("stop_recording");
}
