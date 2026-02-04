import { ActionPanel, Action, List, Icon, Color, showToast, Toast } from "@raycast/api";
import { executeCapAction, isCapInstalled, openCap } from "./utils/deeplink";
import { useEffect, useState } from "react";

interface RecordingAction {
  id: string;
  title: string;
  subtitle: string;
  icon: Icon;
  iconColor?: Color;
  action: () => Promise<void>;
}

export default function Command() {
  const [isInstalled, setIsInstalled] = useState<boolean | null>(null);

  useEffect(() => {
    isCapInstalled().then(setIsInstalled);
  }, []);

  if (isInstalled === null) {
    return <List isLoading={true} />;
  }

  if (!isInstalled) {
    return (
      <List>
        <List.EmptyView
          icon={Icon.Warning}
          title="Cap Not Installed"
          description="Please install Cap from https://cap.so to use this extension."
          actions={
            <ActionPanel>
              <Action.OpenInBrowser title="Download Cap" url="https://cap.so" />
            </ActionPanel>
          }
        />
      </List>
    );
  }

  const actions: RecordingAction[] = [
    {
      id: "start-recording",
      title: "Start Recording",
      subtitle: "Start a new screen recording",
      icon: Icon.Video,
      iconColor: Color.Red,
      action: async () => {
        await executeCapAction(
          {
            start_recording: {
              capture_mode: { screen: "Main Display" },
              camera: null,
              mic_label: null,
              capture_system_audio: false,
              mode: "instant",
            },
          },
          "Recording Started"
        );
      },
    },
    {
      id: "stop-recording",
      title: "Stop Recording",
      subtitle: "Stop the current recording",
      icon: Icon.Stop,
      iconColor: Color.Orange,
      action: async () => {
        await executeCapAction("stop_recording", "Recording Stopped");
      },
    },
    {
      id: "toggle-pause",
      title: "Toggle Pause",
      subtitle: "Pause or resume the current recording",
      icon: Icon.Pause,
      iconColor: Color.Yellow,
      action: async () => {
        await executeCapAction("toggle_pause", "Toggled Pause");
      },
    },
    {
      id: "pause-recording",
      title: "Pause Recording",
      subtitle: "Pause the current recording",
      icon: Icon.Pause,
      action: async () => {
        await executeCapAction("pause_recording", "Recording Paused");
      },
    },
    {
      id: "resume-recording",
      title: "Resume Recording",
      subtitle: "Resume a paused recording",
      icon: Icon.Play,
      iconColor: Color.Green,
      action: async () => {
        await executeCapAction("resume_recording", "Recording Resumed");
      },
    },
    {
      id: "take-screenshot",
      title: "Take Screenshot",
      subtitle: "Capture the current screen",
      icon: Icon.Camera,
      iconColor: Color.Blue,
      action: async () => {
        await executeCapAction("take_screenshot", "Screenshot Taken");
      },
    },
    {
      id: "open-cap",
      title: "Open Cap",
      subtitle: "Open the Cap application",
      icon: Icon.Window,
      action: openCap,
    },
    {
      id: "open-settings",
      title: "Open Settings",
      subtitle: "Open Cap settings",
      icon: Icon.Gear,
      action: async () => {
        await executeCapAction({ open_settings: { page: null } }, "Opening Settings");
      },
    },
  ];

  return (
    <List searchBarPlaceholder="Search Cap commands...">
      <List.Section title="Recording">
        {actions.slice(0, 5).map((item) => (
          <List.Item
            key={item.id}
            icon={{ source: item.icon, tintColor: item.iconColor }}
            title={item.title}
            subtitle={item.subtitle}
            actions={
              <ActionPanel>
                <Action
                  title={item.title}
                  icon={item.icon}
                  onAction={item.action}
                />
              </ActionPanel>
            }
          />
        ))}
      </List.Section>
      <List.Section title="Capture">
        {actions.slice(5, 6).map((item) => (
          <List.Item
            key={item.id}
            icon={{ source: item.icon, tintColor: item.iconColor }}
            title={item.title}
            subtitle={item.subtitle}
            actions={
              <ActionPanel>
                <Action
                  title={item.title}
                  icon={item.icon}
                  onAction={item.action}
                />
              </ActionPanel>
            }
          />
        ))}
      </List.Section>
      <List.Section title="Application">
        {actions.slice(6).map((item) => (
          <List.Item
            key={item.id}
            icon={{ source: item.icon, tintColor: item.iconColor }}
            title={item.title}
            subtitle={item.subtitle}
            actions={
              <ActionPanel>
                <Action
                  title={item.title}
                  icon={item.icon}
                  onAction={item.action}
                />
              </ActionPanel>
            }
          />
        ))}
      </List.Section>
    </List>
  );
}
