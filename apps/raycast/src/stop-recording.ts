import { runAction } from "./cap";

export default async function Command() {
  await runAction("stop_recording", "Stopping Cap recording");
}
