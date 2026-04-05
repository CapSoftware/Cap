import { open, showHUD } from "@raycast/api";
import { buildDeeplinkUrl } from "./utils";

export default async function Command() {
  await open(buildDeeplinkUrl({ open_settings: { page: null } }));
  await showHUD("Opening Cap settings");
}
