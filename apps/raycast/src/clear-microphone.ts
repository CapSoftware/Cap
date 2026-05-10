import { runCapAction } from "./deeplink";

export default async function Command() {
	await runCapAction(
		{ set_microphone: { mic_label: null } },
		"Cleared microphone",
	);
}
