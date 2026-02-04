import { openCapDeepLink } from "./utils";

export default async function Command() {
  await openCapDeepLink({ pause_recording: {} });
}
