import { runCapAction } from "./deeplink";

export default async function Command() {
	await runCapAction("pause_recording", "Paused recording");
}
