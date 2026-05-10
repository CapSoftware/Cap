import { runCapAction } from "./deeplink";

export default async function Command() {
	await runCapAction({ open_settings: { page: null } }, "Opened settings");
}
