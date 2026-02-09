import { Action, ActionPanel, List, showHUD, open } from "@raycast/api";
import { useExec } from "@raycast/utils";

const DEEPLINK_SCHEME = "cap-desktop";

async function switchCamera(name: string) {
  const action = { set_camera: { camera: { DeviceID: name } } };
  const encodedValue = encodeURIComponent(JSON.stringify(action));
  const url = `${DEEPLINK_SCHEME}://action?value=${encodedValue}`;

  try {
    await open(url);
    await showHUD(`Switching camera to "${name}" in Cap`);
  } catch {
    await showHUD("Failed to communicate with Cap. Is Cap running?");
  }
}

async function disableCamera() {
  const action = { set_camera: { camera: null } };
  const encodedValue = encodeURIComponent(JSON.stringify(action));
  const url = `${DEEPLINK_SCHEME}://action?value=${encodedValue}`;

  try {
    await open(url);
    await showHUD("Disabling camera in Cap");
  } catch {
    await showHUD("Failed to communicate with Cap. Is Cap running?");
  }
}

export default function SwitchCamera() {
  const { data, isLoading } = useExec("system_profiler", ["SPCameraDataType", "-detailLevel", "mini"], {
    parseOutput: ({ stdout }) => {
      const cameras: string[] = [];
      const lines = stdout.split("\n");
      for (const line of lines) {
        if (line.match(/^\s{4}\S/) && line.includes(":")) {
          const name = line.trim().replace(/:$/, "");
          if (name.length > 0 && name !== "Camera") {
            cameras.push(name);
          }
        }
      }
      if (cameras.length === 0) {
        cameras.push("FaceTime HD Camera");
      }
      return cameras;
    },
  });

  const cameras = data ?? [];

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Search cameras...">
      <List.Item
        key="disable"
        title="Disable Camera"
        subtitle="Turn off camera input"
        actions={
          <ActionPanel>
            <Action title="Disable Camera" onAction={disableCamera} />
          </ActionPanel>
        }
      />
      {cameras.map((cam) => (
        <List.Item
          key={cam}
          title={cam}
          actions={
            <ActionPanel>
              <Action title={`Switch to ${cam}`} onAction={() => switchCamera(cam)} />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
