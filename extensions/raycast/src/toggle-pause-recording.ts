import { runCapAction } from "./cap";

export default async function Command() {
	await runCapAction("toggle_pause_recording", "Toggling recording pause");
}
