import { runCapAction } from "./deeplink";

export default async function Command() {
	await runCapAction("stop_recording", "Stopped recording");
}
