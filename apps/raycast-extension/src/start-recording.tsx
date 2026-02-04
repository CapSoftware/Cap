import { Action, ActionPanel, Icon, List, showHUD, showToast, Toast } from "@raycast/api";
import { useEffect, useState } from "react";
import { Display, Window, isCapRunning, listDisplays, listWindows, openCap, startRecording } from "./utils/cap";

type CaptureTarget = { type: "screen"; display: Display } | { type: "window"; window: Window };

export default function StartRecording() {
  const [displays, setDisplays] = useState<Display[]>([]);
  const [windows, setWindows] = useState<Window[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedMode, setSelectedMode] = useState<"instant" | "studio">("instant");

  useEffect(() => {
    async function fetchData() {
      const [displayList, windowList] = await Promise.all([listDisplays(), listWindows()]);
      setDisplays(displayList);
      setWindows(windowList);
      setIsLoading(false);
    }
    fetchData();
  }, []);

  async function handleStartRecording(target: CaptureTarget) {
    try {
      const isRunning = await isCapRunning();
      if (!isRunning) {
        await showToast({ style: Toast.Style.Animated, title: "Starting Cap..." });
        await openCap();
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }

      const captureMode =
        target.type === "screen" ? { screen: target.display.name } : { window: target.window.name };

      await startRecording({
        captureMode,
        mode: selectedMode,
      });

      await showHUD(`Recording started (${selectedMode} mode)`);
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed to start recording",
        message: String(error),
      });
    }
  }

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder="Select screen or window to record..."
      searchBarAccessory={
        <List.Dropdown
          tooltip="Recording Mode"
          value={selectedMode}
          onChange={(value) => setSelectedMode(value as "instant" | "studio")}
        >
          <List.Dropdown.Item title="Instant Mode" value="instant" />
          <List.Dropdown.Item title="Studio Mode" value="studio" />
        </List.Dropdown>
      }
    >
      <List.Section title="Displays">
        {displays.map((display) => (
          <List.Item
            key={`display-${display.id}`}
            icon={Icon.Desktop}
            title={display.name}
            subtitle="Full Screen"
            accessories={[{ text: selectedMode === "instant" ? "Instant" : "Studio" }]}
            actions={
              <ActionPanel>
                <Action
                  title="Start Recording"
                  icon={Icon.Video}
                  onAction={() => handleStartRecording({ type: "screen", display })}
                />
              </ActionPanel>
            }
          />
        ))}
      </List.Section>

      <List.Section title="Windows">
        {windows.map((window) => (
          <List.Item
            key={`window-${window.id}`}
            icon={Icon.Window}
            title={window.name}
            subtitle={window.owner}
            accessories={[{ text: selectedMode === "instant" ? "Instant" : "Studio" }]}
            actions={
              <ActionPanel>
                <Action
                  title="Start Recording"
                  icon={Icon.Video}
                  onAction={() => handleStartRecording({ type: "window", window })}
                />
              </ActionPanel>
            }
          />
        ))}
      </List.Section>
    </List>
  );
}
