import { runCapAction } from "./deeplink";

export default async function Command() {
	await runCapAction("resume_recording", "Resumed recording");
}
