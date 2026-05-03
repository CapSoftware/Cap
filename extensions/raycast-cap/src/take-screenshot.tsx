import { executeCapAction } from "./utils/deeplink";

export default async function Command() {
  await executeCapAction("take_screenshot", "Screenshot Taken");
}
