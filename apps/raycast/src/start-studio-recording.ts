import { runCapAction } from "./deeplink";

export default async function Command() {
	await runCapAction(
		{ start_recording_from_settings: { mode: "studio" } },
		"Started Studio recording",
	);
}
