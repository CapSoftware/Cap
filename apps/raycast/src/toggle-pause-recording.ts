import { runCapAction } from "./deeplink";

export default async function Command() {
	await runCapAction("toggle_pause_recording", "Toggled pause");
}
