import { runCapAction } from "./cap";

export default async function Command() {
	await runCapAction("stop_recording", "Stopping recording");
}
