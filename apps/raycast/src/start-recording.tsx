import { ActionPanel, Action, List, showHUD, popToRoot } from "@raycast/api";
import { useExec } from "@raycast/utils";
import { executeDeepLink, parseDisplayNames } from "./utils";

export default function StartRecording() {
  const { data, isLoading } = useExec("system_profiler", ["SPDisplaysDataType"]);

  const displays = data ? parseDisplayNames(data) : [];

  async function startRecording(screenName: string, mode: "studio" | "instant") {
    await executeDeepLink("record/start", {
      screen: screenName,
      mode,
    });
    await showHUD(`▶️ Recording started (${mode})`);
    await popToRoot();
  }

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Select a display to record...">
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
                  title="Start Studio Recording"
                  onAction={() => startRecording(name, "studio")}
                />
                <Action
                  title="Start Instant Recording"
                  onAction={() => startRecording(name, "instant")}
                />
              </ActionPanel>
            }
          />
        ))
      )}
    </List>
  );
}
