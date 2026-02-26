import { Action, ActionPanel, List } from "@raycast/api";
import { useExec } from "@raycast/utils";
import { executeDeepLink } from "./utils";

async function switchMicrophone(label: string) {
  await executeDeepLink(
    { set_microphone: { mic_label: label } },
    `Switching microphone to "${label}" in Cap`,
  );
}

async function disableMicrophone() {
  await executeDeepLink(
    { set_microphone: { mic_label: null } },
    "Disabling microphone in Cap",
  );
}

export default function SwitchMicrophone() {
  const { data, isLoading } = useExec("system_profiler", ["SPAudioDataType", "-detailLevel", "mini"], {
    parseOutput: ({ stdout }) => {
      const devices: string[] = [];
      const lines = stdout.split("\n");
      let inInput = false;
      for (const line of lines) {
        if (line.includes("Input:")) {
          inInput = true;
          continue;
        }
        if (line.includes("Output:")) {
          inInput = false;
          continue;
        }
        if (inInput && line.match(/^\s{8}\S/)) {
          const name = line.trim().replace(/:$/, "");
          if (name.length > 0) {
            devices.push(name);
          }
        }
      }
      return devices;
    },
  });

  const microphones = data ?? [];

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Search microphones...">
      <List.Item
        key="disable"
        title="Disable Microphone"
        subtitle="Turn off microphone input"
        actions={
          <ActionPanel>
            <Action title="Disable Microphone" onAction={disableMicrophone} />
          </ActionPanel>
        }
      />
      {microphones.map((mic) => (
        <List.Item
          key={mic}
          title={mic}
          actions={
            <ActionPanel>
              <Action title={`Switch to ${mic}`} onAction={() => switchMicrophone(mic)} />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
