import { runCapAction } from "./cap";

export default async function Command() {
	await runCapAction(
		{ start_recording_with_settings: { mode: "studio" } },
		"Starting Studio recording",
	);
}
