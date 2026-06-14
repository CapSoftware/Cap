import { ActionPanel, Action, List, showHUD, popToRoot } from "@raycast/api";
import { useExec } from "@raycast/utils";
import { executeDeepLink, parseDisplayNames } from "./utils";

export default function TakeScreenshot() {
  const { data, isLoading } = useExec("system_profiler", ["SPDisplaysDataType"]);

  const displays = data ? parseDisplayNames(data) : [];

  async function takeScreenshot(screenName: string) {
    await executeDeepLink("screenshot", { screen: screenName });
    await showHUD("📸 Screenshot taken");
    await popToRoot();
  }

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Select a display...">
      {displays.length === 0 && !isLoading ? (
        <List.EmptyView
          title="No Displays Found"
          description="Could not detect any displays on this system."
        />
      ) : (
        displays.map((name) => (
          <List.Item
            key={name}
            title={name}
            icon="🖥️"
            actions={
              <ActionPanel>
                <Action
                  title="Take Screenshot"
                  onAction={() => takeScreenshot(name)}
                />
              </ActionPanel>
            }
          />
        ))
      )}
    </List>
  );
}
