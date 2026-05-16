import { runCapAction } from "./cap";

export default async function Command() {
	await runCapAction(
		{ open_recording_picker: { target_mode: "window" } },
		"Opening window picker",
	);
}
