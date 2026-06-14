import { fireAction } from "./deeplink";

export default async function StopRecording(): Promise<void> {
	await fireAction("stop_recording", "Cap recording stopped");
}
