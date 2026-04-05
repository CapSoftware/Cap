import { triggerDeepLink } from "./utils";

export default async function Command() {
  await triggerDeepLink(
    { open_settings: { page: null } },
    "⚙️ Opening Cap settings…",
  );
}
