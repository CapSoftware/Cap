import { runCapAction } from "./deeplink";

export default async function Command() {
	await runCapAction("restart_recording", "Restarted recording");
}
