import { List, ActionPanel, Action, showHUD, open } from "@raycast/api";
import { useState, useEffect } from "react";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

interface Window {
  name: string;
  app: string;
}

export default function Command() {
  const [windows, setWindows] = useState<Window[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function fetchWindows() {
      try {
        // Get list of windows using AppleScript
        const { stdout } = await execAsync(`
          osascript -e 'tell application "System Events" to get name of (processes where background only is false)'
        `);
        
        const apps = stdout.trim().split(", ");
        const windowList: Window[] = apps.map((app) => ({
          name: app,
          app: app,
        }));

        setWindows(windowList);
      } catch (error) {
        console.error("Failed to fetch windows:", error);
      } finally {
        setIsLoading(false);
      }
    }

    fetchWindows();
  }, []);

  async function startRecordingWindow(windowName: string) {
    try {
      const action = {
        capture_mode: { window: windowName },
        camera: null,
        mic_label: null,
        capture_system_audio: true,
        mode: "desktop",
      };

      const encodedAction = encodeURIComponent(JSON.stringify(action));
      const deeplinkUrl = `cap://action?value=${encodedAction}`;

      await open(deeplinkUrl);
      await showHUD(`✅ Started recording ${windowName}`);
    } catch (error) {
      console.error("Failed to start recording:", error);
      await showHUD("❌ Failed to start recording");
    }
  }

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Search windows...">
      {windows.map((window, index) => (
        <List.Item
          key={index}
          title={window.name}
          subtitle={window.app}
          actions={
            <ActionPanel>
              <Action
                title="Start Recording"
                onAction={() => startRecordingWindow(window.name)}
              />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
