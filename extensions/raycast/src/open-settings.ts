import { openSettings } from "./utils/deeplink";

export default async function Command() {
  await openSettings();
}
