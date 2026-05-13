import { runAction } from "./cap";

export default async function Command() {
  await runAction("resume_recording", "Resuming Cap recording");
}
