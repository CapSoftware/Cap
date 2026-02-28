import { simpleCapAction } from "./utils";

export default async function Command() {
  await simpleCapAction("stop_recording");
}
