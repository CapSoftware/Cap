import { executeCapAction } from "./utils/deeplink";

export default async function Command() {
  await executeCapAction("toggle_pause", "Toggled Pause");
}
