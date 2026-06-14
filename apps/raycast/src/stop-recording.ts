import { executeDeepLink } from "./utils";

export default async function command() {
  await executeDeepLink({ stop_recording: {} }, "Stopping recording...");
}
