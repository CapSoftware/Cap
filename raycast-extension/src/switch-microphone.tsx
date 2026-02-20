import { List, ActionPanel, Action, showHUD, open } from "@raycast/api";
import { useState, useEffect } from "react";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

interface Microphone {
  id: string;
  name: string;
}

export default function Command() {
  const [microphones, setMicrophones] = useState<Microphone[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function fetchMicrophones() {
      try {
        // Get list of audio input devices
        const { stdout } = await execAsync(
          `system_profiler SPAudioDataType | grep -A 1 "Input Source" | grep -v "Input Source" | awk '{print $1}'`
        );
        
        const micNames = stdout.trim().split("\n").filter(Boolean);
        const micList: Microphone[] = micNames.map((name, index) => ({
          id: name,
          name: name || `Microphone ${index + 1}`,
        }));

        // Add built-in microphone if available
        if (micList.length === 0) {
          micList.push({
            id: "built-in",
            name: "Built-in Microphone",
          });
        }

        setMicrophones(micList);
      } catch (error) {
        console.error("Failed to fetch microphones:", error);
        // Fallback to built-in microphone
        setMicrophones([{ id: "built-in", name: "Built-in Microphone" }]);
      } finally {
        setIsLoading(false);
      }
    }

    fetchMicrophones();
  }, []);

  async function switchMicrophone(micId: string) {
    try {
      const action = {
        switch_microphone: {
          mic_label: micId,
        },
      };

      const encodedAction = encodeURIComponent(JSON.stringify(action));
      const deeplinkUrl = `cap://action?value=${encodedAction}`;

      await open(deeplinkUrl);
      await showHUD(`🎤 Switched to microphone: ${micId}`);
    } catch (error) {
      console.error("Failed to switch microphone:", error);
      await showHUD("❌ Failed to switch microphone");
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
              <Action
                title="Switch to This Microphone"
                onAction={() => switchMicrophone(mic.id)}
              />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
