import { triggerCapDeepLink } from "./deeplink";

export default async function Command() {
  await triggerCapDeepLink(
    "cap-desktop://record/toggle-pause",
    "Sent: Toggle pause",
  );
}
