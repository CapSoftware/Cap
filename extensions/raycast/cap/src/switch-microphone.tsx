import { List, ActionPanel, Action, showToast, Toast } from "@raycast/api";
import { useState, useEffect } from "react";
import { sendDeepLink } from "./utils";

interface Microphone {
  id: string;
  name: string;
}

export default function Command() {
  const [microphones, setMicrophones] = useState<Microphone[]>([
    { id: "default", name: "System Default" },
    { id: "none", name: "No Microphone" },
  ]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // In a future iteration, this could fetch available microphones from Cap
    // For now, we provide the basic options
    setIsLoading(false);
  }, []);

  async function handleSwitchMicrophone(micId: string) {
    try {
      const micLabel = micId === "none" ? null : micId === "default" ? null : micId;
      
      await sendDeepLink("switch_microphone", {
        mic_label: micLabel,
      });

      await showToast({
        style: Toast.Style.Success,
        title: "Switching microphone...",
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
    <List isLoading={isLoading} searchBarPlaceholder="Search microphones...">
      {microphones.map((mic) => (
        <List.Item
          key={mic.id}
          title={mic.name}
          icon={mic.id === "none" ? "🚫" : "🎤"}
          actions={
            <ActionPanel>
              <Action title="Switch to Microphone" onAction={() => handleSwitchMicrophone(mic.id)} />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
