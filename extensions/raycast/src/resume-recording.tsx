import { simpleCapAction } from "./utils";

export default async function Command() {
  await simpleCapAction("resume_recording");
}
