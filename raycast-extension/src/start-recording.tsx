import { Action, ActionPanel, List, showToast, Toast } from "@raycast/api";
import { useState, useEffect } from "react";
import { startRecording, isCapInstalled } from "./cap";

export default function Command() {
  const [installed, setInstalled] = useState<boolean>(true);
  
  useEffect(() => {
    isCapInstalled().then(setInstalled);
  }, []);
  
  if (!installed) {
    return (
      <List>
        <List.EmptyView
          title="Cap not installed"
          description="Please install Cap from https://cap.so"
        />
      </List>
    );
  }
  
  return (
    <List>
      <List.Section title="Quick Recording">
        <List.Item
          title="Start Recording"
          subtitle="Record entire screen"
          actions={
            <ActionPanel>
              <Action
                title="Start Recording"
                onAction={async () => {
                  await startRecording({ systemAudio: true });
                  await showToast({
                    style: Toast.Style.Success,
                    title: "Recording started",
                  });
                }}
              />
            </ActionPanel>
          }
        />
        <List.Item
          title="Start Recording (No Audio)"
          subtitle="Record without audio"
          actions={
            <ActionPanel>
              <Action
                title="Start Recording"
                onAction={async () => {
                  await startRecording({ systemAudio: false });
                  await showToast({
                    style: Toast.Style.Success,
                    title: "Recording started (no audio)",
                  });
                }}
              />
            </ActionPanel>
          }
        />
      </List.Section>
    </List>
  );
}
