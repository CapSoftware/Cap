import { fireAction } from "./deeplink";

export default async function ResumeRecording(): Promise<void> {
	await fireAction("resume_recording", "Cap recording resumed");
}
