import { triggerCapAction } from "./utils";

export default async function Command() {
  await triggerCapAction({ open_settings: { page: null } });
}
