import { runNoViewAction } from "./cap";
export default async function Command() {
  await runNoViewAction("pause", "Pausing Cap recording");
}
