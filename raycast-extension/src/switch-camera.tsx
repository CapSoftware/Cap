import { ActionPanel, Action, List, showHUD, Icon } from "@raycast/api";
import { triggerDeeplink } from "./lib/deeplink";

// Common camera labels — users can extend this list
const CAMERAS = [
  "FaceTime HD Camera",
  "FaceTime HD Camera (Built-in)",
  "Continuity Camera",
  "OBS Virtual Camera",
  "Logitech C920",
  "Logitech StreamCam",
  "Sony Alpha",
];

export default function Command() {
  return (
    <List navigationTitle="Switch Camera" searchBarPlaceholder="Search cameras...">
      {CAMERAS.map((cam) => (
        <List.Item
          key={cam}
          icon={Icon.Camera}
          title={cam}
          actions={
            <ActionPanel>
              <Action
                title="Select Camera"
                onAction={async () => {
                  await triggerDeeplink({ SwitchCamera: { label: cam } });
                  await showHUD(`📷 Switched to ${cam}`);
                }}
              />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
