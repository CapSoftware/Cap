import { Action, ActionPanel, List, showHUD, open } from "@raycast/api";
import { useExec } from "@raycast/utils";

const DEEPLINK_SCHEME = "cap-desktop";

function parseMicrophones(output: string): string[] {
  const devices: string[] = [];
  const lines = output.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 0 && trimmed !== "None") {
      devices.push(trimmed);
    }
  }
  return devices;
}

async function switchMicrophone(label: string) {
  const action = { set_microphone: { mic_label: label } };
  const encodedValue = encodeURIComponent(JSON.stringify(action));
  const url = `${DEEPLINK_SCHEME}://action?value=${encodedValue}`;

  try {
    await open(url);
    await showHUD(`Switching microphone to "${label}" in Cap`);
  } catch {
    await showHUD("Failed to communicate with Cap. Is Cap running?");
  }
}

async function disableMicrophone() {
  const action = { set_microphone: { mic_label: null } };
  const encodedValue = encodeURIComponent(JSON.stringify(action));
  const url = `${DEEPLINK_SCHEME}://action?value=${encodedValue}`;

  try {
    await open(url);
    await showHUD("Disabling microphone in Cap");
  } catch {
    await showHUD("Failed to communicate with Cap. Is Cap running?");
  }
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
      if (devices.length === 0) {
        devices.push("MacBook Pro Microphone");
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
