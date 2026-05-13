import { ActionPanel, Action, List, closeMainWindow, open } from "@raycast/api";

interface SwitchCameraArguments {
  camera?: string;
}

export default function Command(props: { arguments: SwitchCameraArguments }) {
  const cameras = [
    { name: "Built-in Camera", id: "built-in" },
    { name: "External Camera", id: "external" },
  ];

  return (
    <List>
      {cameras.map((camera) => (
        <List.Item
          key={camera.id}
          title={camera.name}
          icon="📹"
          actions={
            <ActionPanel>
              <Action
                title="Switch to This Camera"
                onAction={async () => {
                  await closeMainWindow();
                  await open(
                    `cap-desktop://action?value=${encodeURIComponent(
                      JSON.stringify({
                        switch_camera: {
                          camera: { DeviceID: props.arguments.camera || camera.name },
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
    </List>
  );
}
