import { runCapAction } from "./cap";

export default async function Command() {
	await runCapAction({ set_mic_input: { label: null } }, "Clearing microphone");
}
