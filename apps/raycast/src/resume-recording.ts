import { dispatchSimpleAction } from "./utils";

export default async function Command() {
  await dispatchSimpleAction("resume_recording");
}
