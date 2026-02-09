import { ActionPanel, Action, List } from "@raycast/api";
import { useExec } from "@raycast/utils";
import { executeDeepLink } from "./utils";

function parseDisplays(stdout: string): string[] {
  const displays: string[] = [];
  const lines = stdout.split("\n");
  for (const line of lines) {
    const match = line.match(/^\s{8}(\S.*):$/);
    if (match && match[1]) {
      displays.push(match[1]);
    }
  }
  return displays;
}

async function startRecordingOnDisplay(displayName: string) {
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
    `Starting recording on "${displayName}" in Cap`,
  );
}

export default function StartRecording() {
  const { data, isLoading } = useExec("system_profiler", ["SPDisplaysDataType", "-detailLevel", "mini"], {
    parseOutput: ({ stdout }) => parseDisplays(stdout),
  });

  const displays = data ?? [];

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Select a display to record...">
      {displays.map((display) => (
        <List.Item
          key={display}
          title={display}
          actions={
            <ActionPanel>
              <Action title={`Record ${display}`} onAction={() => startRecordingOnDisplay(display)} />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
