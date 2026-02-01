import { executeCapAction } from "./utils/deeplink";

export default async function Command() {
  await executeCapAction(
    { open_settings: { page: null } },
    "Opening Settings"
  );
}
