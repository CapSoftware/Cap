import { executeDeepLink } from "./utils";

export default async function command() {
  await executeDeepLink(
    { open_settings: { page: null } },
    "Opening Cap settings...",
  );
}
