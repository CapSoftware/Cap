import { runNoViewAction } from "./cap";
export default async function Command() {
  await runNoViewAction("stop", "Stopping Cap recording");
}
