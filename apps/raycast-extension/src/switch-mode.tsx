import { ActionPanel, Action, List, showHUD } from "@raycast/api";
import { openDeeplink } from "./utils/deeplink";

const MODES = [
  { id: "screen", title: "Screen Recording", icon: "🖥" },
  { id: "window", title: "Window Recording", icon: "🪟" },
  { id: "camera", title: "Camera Only", icon: "📷" },
];

export default function SwitchMode() {
  return (
    <List navigationTitle="Switch Recording Mode">
      {MODES.map((mode) => (
        <List.Item
          key={mode.id}
          icon={mode.icon}
          title={mode.title}
          actions={
            <ActionPanel>
              <Action
                title={`Switch to ${mode.title}`}
                onAction={async () => {
                  await openDeeplink(`cap://record/switch-mode?mode=${mode.id}`);
                  await showHUD(`${mode.icon} Switched to ${mode.title}`);
                }}
              />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
