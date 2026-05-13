import { triggerCapAction } from "./lib/cap";

export default async function Command() {
	await triggerCapAction({ stop_recording: null }, "Cap stop recording request sent");
}
