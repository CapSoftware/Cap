import { runCapAction } from "./cap";

export default async function Command() {
	await runCapAction("pause_recording", "Pausing recording");
}
