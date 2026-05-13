import { ActionPanel, Action, List, closeMainWindow, open } from "@raycast/api";

interface SwitchMicrophoneArguments {
  microphone?: string;
}

export default function Command(props: { arguments: SwitchMicrophoneArguments }) {
  const microphones = [
    { name: "Built-in Microphone" },
    { name: "External Microphone" },
  ];

  return (
    <List>
      {microphones.map((mic) => (
        <List.Item
          key={mic.name}
          title={mic.name}
          icon="🎤"
          actions={
            <ActionPanel>
              <Action
                title="Switch to This Microphone"
                onAction={async () => {
                  await closeMainWindow();
                  await open(
                    `cap-desktop://action?value=${encodeURIComponent(
                      JSON.stringify({
                        switch_microphone: {
                          mic_label: mic.name,
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
