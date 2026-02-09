import { execSync } from "child_process";
import { executeDeepLink } from "./utils";

function getMainDisplayName(): string {
  try {
    const output = execSync("system_profiler SPDisplaysDataType -detailLevel mini", {
      encoding: "utf-8",
    });
    const lines = output.split("\n");
    for (const line of lines) {
      const match = line.match(/^\s{8}(\S.*):$/);
      if (match && match[1]) {
        return match[1];
      }
    }
  } catch {
  }
  return "Main Display";
}

export default async function StartRecording() {
  const displayName = getMainDisplayName();
  await executeDeepLink(
    {
      start_recording: {
        capture_mode: { screen: displayName },
        camera: null,
        mic_label: null,
        capture_system_audio: false,
        mode: "studio",
      },
    },
    "Starting recording in Cap",
  );
}
