import { triggerCapAction } from "./lib/cap";

export default async function Command() {
	await triggerCapAction({ resume_recording: null }, "Cap resume recording request sent");
}
