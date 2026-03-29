import { triggerDeeplink } from "./utils/deeplink";

export default async function Command() {
  await triggerDeeplink("record/start", "▶ Cap recording started");
}
