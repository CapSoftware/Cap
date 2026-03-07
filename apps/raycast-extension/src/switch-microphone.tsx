import { Action, ActionPanel, Icon, List, showHUD, showToast, Toast } from "@raycast/api";
import { useEffect, useState } from "react";
import { Microphone, isCapRunning, listMicrophones, openCap, switchMicrophone } from "./utils/cap";

export default function SwitchMicrophone() {
  const [microphones, setMicrophones] = useState<Microphone[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function fetchMicrophones() {
      const micList = await listMicrophones();
      setMicrophones(micList);
      setIsLoading(false);
    }
    fetchMicrophones();
  }, []);

  async function handleSwitchMicrophone(mic: Microphone | null) {
    try {
      const isRunning = await isCapRunning();
      if (!isRunning) {
        await showToast({ style: Toast.Style.Animated, title: "Starting Cap..." });
        await openCap();
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }

      await switchMicrophone(mic?.label ?? null);
      await showHUD(mic ? `Switched to ${mic.label}` : "Microphone disabled");
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed to switch microphone",
        message: String(error),
      });
    }
  }

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Select a microphone...">
      <List.Item
        icon={Icon.XMarkCircle}
        title="No Microphone"
        subtitle="Disable microphone"
        actions={
          <ActionPanel>
            <Action
              title="Disable Microphone"
              icon={Icon.XMarkCircle}
              onAction={() => handleSwitchMicrophone(null)}
            />
          </ActionPanel>
        }
      />
      {microphones.map((mic) => (
        <List.Item
          key={mic.label}
          icon={Icon.Microphone}
          title={mic.label}
          actions={
            <ActionPanel>
              <Action
                title="Switch to This Microphone"
                icon={Icon.Microphone}
                onAction={() => handleSwitchMicrophone(mic)}
              />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
