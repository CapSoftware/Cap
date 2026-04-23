import { ActionPanel, Action, List, showHUD, Icon } from "@raycast/api";
import { triggerDeeplink } from "./lib/deeplink";

// Common microphone labels — users can extend this list
const MICROPHONES = [
  "MacBook Pro Microphone",
  "Built-in Microphone",
  "AirPods Pro",
  "AirPods Max",
  "USB Audio Device",
  "Rode NT-USB",
  "Blue Yeti",
];

export default function Command() {
  return (
    <List navigationTitle="Switch Microphone" searchBarPlaceholder="Search microphones...">
      {MICROPHONES.map((mic) => (
        <List.Item
          key={mic}
          icon={Icon.Microphone}
          title={mic}
          actions={
            <ActionPanel>
              <Action
                title="Select Microphone"
                onAction={async () => {
                  await triggerDeeplink({ SwitchMicrophone: { label: mic } });
                  await showHUD(`🎙 Switched to ${mic}`);
                }}
              />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
