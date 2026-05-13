import { triggerCapAction } from "./lib/cap";

export default async function Command() {
	await triggerCapAction({ pause_recording: null }, "Cap pause recording request sent");
}
