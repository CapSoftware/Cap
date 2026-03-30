import { triggerDeeplink } from "./utils/deeplink";

export default async function Command() {
  await triggerDeeplink("record/stop", "⏹ Cap recording stopped");
}
