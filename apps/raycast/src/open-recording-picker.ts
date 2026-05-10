import { runCapAction } from "./deeplink";

export default async function Command() {
	await runCapAction(
		{ open_recording_picker: { target_mode: null } },
		"Opened recording picker",
	);
}
