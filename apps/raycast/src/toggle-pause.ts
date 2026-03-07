import { executeDeepLink } from "./utils";

export default async function command() {
  await executeDeepLink({ toggle_pause: {} }, "Toggling pause...");
}
