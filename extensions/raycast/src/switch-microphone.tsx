import { ActionPanel, Action, List, showToast, Toast } from "@raycast/api";
import { executeCapAction } from "./utils";

export default function Command() {
  // In a real implementation, you would fetch available microphones
  // For now, we'll use placeholder microphone names
  const microphones = [
    { label: "default", name: "Default Microphone" },
    { label: "built-in", name: "Built-in Microphone" },
  ];

  async function switchMicrophone(micLabel: string, micName: string) {
    try {
      await showToast({
        style: Toast.Style.Animated,
        title: `Switching to ${micName}...`,
      });

      await executeCapAction({
        switch_microphone: {
          mic_label: micLabel,
        },
      });

      await showToast({
        style: Toast.Style.Success,
        title: `Switched to ${micName}`,
      });
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed to switch microphone",
        message: String(error),
      });
    }
  }

  return (
    <List>
      {microphones.map((mic) => (
        <List.Item
          key={mic.label}
          title={mic.name}
          actions={
            <ActionPanel>
              <Action
                title="Switch to This Microphone"
                onAction={() => switchMicrophone(mic.label, mic.name)}
              />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
