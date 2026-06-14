import { fireSimpleAction } from "./lib/cap";

export default async function Command() {
  await fireSimpleAction("resume_recording");
}
