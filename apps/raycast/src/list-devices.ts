import { ActionPanel, Action, List, closeMainWindow, open } from "@raycast/api";
import { useEffect, useState } from "react";

interface Device {
  name: string;
  type: "camera" | "microphone";
}

export default function Command() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function fetchDevices() {
      // Refresh device cache via deeplink
      await open(
        `cap-desktop://action?value=${encodeURIComponent(JSON.stringify("refresh_raycast_device_cache"))}`
      );
      setIsLoading(false);
    }

    fetchDevices();
  }, []);

  useEffect(() => {
    // Populate with known device types — actual list comes from the Cap app
    setDevices([
      { name: "Built-in Camera", type: "camera" },
      { name: "Built-in Microphone", type: "microphone" },
    ]);
    setIsLoading(false);
  }, []);

  return (
    <List isLoading={isLoading}>
      <List.Section title="Cameras">
        {devices
          .filter((d) => d.type === "camera")
          .map((device) => (
            <List.Item
              key={device.name}
              title={device.name}
              icon="📹"
              actions={
                <ActionPanel>
                  <Action
                    title="Select Camera"
                    onAction={async () => {
                      await closeMainWindow();
                      await open(
                        `cap-desktop://action?value=${encodeURIComponent(
                          JSON.stringify({
                            switch_camera: {
                              camera: { DeviceID: device.name },
                            },
                          })
                        )}`
                      );
                    }}
                  />
                </ActionPanel>
              }
            />
          ))}
      </List.Section>
      <List.Section title="Microphones">
        {devices
          .filter((d) => d.type === "microphone")
          .map((device) => (
            <List.Item
              key={device.name}
              title={device.name}
              icon="🎤"
              actions={
                <ActionPanel>
                  <Action
                    title="Select Microphone"
                    onAction={async () => {
                      await closeMainWindow();
                      await open(
                        `cap-desktop://action?value=${encodeURIComponent(
                          JSON.stringify({
                            switch_microphone: {
                              mic_label: device.name,
                            },
                          })
                        )}`
                      );
                    }}
                  />
                </ActionPanel>
              }
            />
          ))}
      </List.Section>
    </List>
  );
}
