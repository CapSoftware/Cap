import { Action, ActionPanel, List } from "@raycast/api";
import { useExec } from "@raycast/utils";
import { executeDeepLink } from "./utils";

interface Camera {
  name: string;
  uniqueId: string;
}

async function switchCamera(camera: Camera) {
  await executeDeepLink(
    { set_camera: { camera: { DeviceID: camera.uniqueId } } },
    `Switching camera to "${camera.name}" in Cap`,
  );
}

async function disableCamera() {
  await executeDeepLink(
    { set_camera: { camera: null } },
    "Disabling camera in Cap",
  );
}

export default function SwitchCamera() {
  const { data, isLoading } = useExec("system_profiler", ["SPCameraDataType", "-detailLevel", "mini"], {
    parseOutput: ({ stdout }) => {
      const cameras: Camera[] = [];
      const lines = stdout.split("\n");
      let currentName: string | null = null;
      let currentUniqueId: string | null = null;

      for (const line of lines) {
        if (line.match(/^\s{4}\S/) && line.includes(":")) {
          if (currentName && currentUniqueId) {
            cameras.push({ name: currentName, uniqueId: currentUniqueId });
          }
          const name = line.trim().replace(/:$/, "");
          if (name.length > 0 && name !== "Camera") {
            currentName = name;
            currentUniqueId = null;
          } else {
            currentName = null;
            currentUniqueId = null;
          }
        }

        const uniqueIdMatch = line.match(/^\s+Unique ID:\s*(.+)/);
        if (uniqueIdMatch && currentName) {
          currentUniqueId = uniqueIdMatch[1].trim();
        }
      }

      if (currentName && currentUniqueId) {
        cameras.push({ name: currentName, uniqueId: currentUniqueId });
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
          key={cam.uniqueId}
          title={cam.name}
          actions={
            <ActionPanel>
              <Action title={`Switch to ${cam.name}`} onAction={() => switchCamera(cam)} />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
