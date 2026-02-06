import { Action, ActionPanel, List, showToast, Toast } from "@raycast/api";
import { useState, useEffect } from "react";
import { openDeepLink, generateDeepLink } from "./utils";

interface Microphone {
  id: string;
  name: string;
}

export default function Command() {
  const [microphones, setMicrophones] = useState<Microphone[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // In a real implementation, this would fetch from Cap
    // For now, showing example microphones
    setMicrophones([
      { id: "default", name: "Default Microphone" },
      { id: "built-in", name: "Built-in Microphone" },
      { id: "external", name: "External Microphone" },
    ]);
    setIsLoading(false);
  }, []);

  async function switchMicrophone(mic: Microphone) {
    try {
      await openDeepLink(generateDeepLink("switch-mic", { label: mic.id }));
      
      await showToast({
        style: Toast.Style.Success,
        title: `Switched to ${mic.name}`,
      });
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed to Switch Microphone",
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
          actions={
            <ActionPanel>
              <Action title="Switch" onAction={() => switchMicrophone(mic)} />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
