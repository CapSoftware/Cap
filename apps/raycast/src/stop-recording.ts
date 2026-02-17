import { triggerCapDeepLink } from "./deeplink";

export default async function Command() {
  await triggerCapDeepLink("cap-desktop://record/stop", "Sent: Stop recording");
}
