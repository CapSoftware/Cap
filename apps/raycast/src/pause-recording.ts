import { runAction } from "./cap";

export default async function Command() {
  await runAction("pause_recording", "Pausing Cap recording");
}
