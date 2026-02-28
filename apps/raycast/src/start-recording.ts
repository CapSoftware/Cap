import { getPreferenceValues } from "@raycast/api";
import { startRecording } from "./utils";

interface Preferences {
  defaultDisplay?: string;
}

export default async function Command() {
  const { defaultDisplay } = getPreferenceValues<Preferences>();
  await startRecording(defaultDisplay || "Main Display");
}
