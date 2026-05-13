import { runNoViewAction } from "./cap";
export default async function Command() {
  await runNoViewAction("resume", "Resuming Cap recording");
}
