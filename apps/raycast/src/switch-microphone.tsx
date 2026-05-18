import { ActionPanel, Action, List, showHUD, popToRoot, Icon } from "@raycast/api";
import { useExec } from "@raycast/utils";
import { executeDeepLink, parseMicrophoneNames } from "./utils";

export default function SwitchMicrophone() {
  const { data, isLoading } = useExec("system_profiler", ["SPAudioDataType"]);

  const microphones = data ? parseMicrophoneNames(data) : [];

  async function selectMicrophone(label: string) {
    await executeDeepLink("device/microphone", { label });
    await showHUD(`🎤 Microphone set to "${label}"`);
    await popToRoot();
  }

  async function disableMicrophone() {
    await executeDeepLink("device/microphone");
    await showHUD("🔇 Microphone disabled");
    await popToRoot();
  }

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Select a microphone...">
      {microphones.length === 0 && !isLoading ? (
        <List.EmptyView
          title="No Microphones Found"
          description="Could not detect any input devices on this system."
        />
      ) : (
        <>
          {microphones.map((name) => (
            <List.Item
              key={name}
              title={name}
              icon={Icon.Microphone}
              actions={
                <ActionPanel>
                  <Action
                    title="Select Microphone"
                    onAction={() => selectMicrophone(name)}
                  />
                </ActionPanel>
              }
            />
          ))}
          <List.Item
            key="disable"
            title="Disable Microphone"
            icon={Icon.XMarkCircle}
            actions={
              <ActionPanel>
                <Action
                  title="Disable Microphone"
                  onAction={disableMicrophone}
                />
              </ActionPanel>
            }
          />
        </>
      )}
    </List>
  );
}
