import { runNoViewAction } from "./cap";
export default async function Command() {
  await runNoViewAction("toggle-pause", "Toggling Cap pause");
}
