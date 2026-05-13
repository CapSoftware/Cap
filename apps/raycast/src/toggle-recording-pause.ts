import { triggerCapAction } from "./lib/cap";

export default async function Command() {
	await triggerCapAction(
		{ toggle_pause_recording: null },
		"Cap toggle pause request sent",
	);
}
