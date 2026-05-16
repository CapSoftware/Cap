import { runCapAction } from "./cap";

export default async function Command() {
	await runCapAction("resume_recording", "Resuming recording");
}
