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

async function takeScreenshotOnDisplay(displayName: string) {
  await executeDeepLink(
    {
      take_screenshot: {
        capture_mode: { screen: displayName },
      },
    },
    `Taking screenshot of "${displayName}" with Cap`,
  );
}

export default function TakeScreenshot() {
  const { data, isLoading } = useExec("system_profiler", ["SPDisplaysDataType", "-detailLevel", "mini"], {
    parseOutput: ({ stdout }) => parseDisplays(stdout),
  });

  const displays = data ?? [];

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Select a display to screenshot...">
      {displays.map((display) => (
        <List.Item
          key={display}
          title={display}
          actions={
            <ActionPanel>
              <Action title={`Screenshot ${display}`} onAction={() => takeScreenshotOnDisplay(display)} />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
