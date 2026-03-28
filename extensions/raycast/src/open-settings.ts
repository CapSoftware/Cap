import { showHUD } from "@raycast/api";
import { sendDeepLink } from "./utils";

export default async function Command() {
  await sendDeepLink({ open_settings: { page: null } });
  await showHUD("Opening Cap settings");
}
