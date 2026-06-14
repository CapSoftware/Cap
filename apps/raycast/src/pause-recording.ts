import { fireAction } from "./deeplink";

export default async function PauseRecording(): Promise<void> {
	await fireAction("pause_recording", "Cap recording paused");
}
