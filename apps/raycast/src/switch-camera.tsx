import { ActionPanel, Action, List, showHUD, popToRoot, Icon } from "@raycast/api";
import { useExec } from "@raycast/utils";
import { executeDeepLink, parseCameras } from "./utils";

export default function SwitchCamera() {
  const { data, isLoading } = useExec("system_profiler", ["SPCameraDataType"]);

  const cameras = data ? parseCameras(data) : [];

  async function selectCamera(uniqueId: string, name: string) {
    await executeDeepLink("device/camera", { device_id: uniqueId });
    await showHUD(`📷 Camera set to "${name}"`);
    await popToRoot();
  }

  async function disableCamera() {
    await executeDeepLink("device/camera", { off: "true" });
    await showHUD("📷 Camera disabled");
    await popToRoot();
  }

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Select a camera...">
      {cameras.length === 0 && !isLoading ? (
        <List.EmptyView
          title="No Cameras Found"
          description="Could not detect any cameras on this system."
        />
      ) : (
        <>
          {cameras.map((camera) => (
            <List.Item
              key={camera.uniqueId}
              title={camera.name}
              subtitle={camera.uniqueId}
              icon={Icon.Camera}
              actions={
                <ActionPanel>
                  <Action
                    title="Select Camera"
                    onAction={() => selectCamera(camera.uniqueId, camera.name)}
                  />
                </ActionPanel>
              }
            />
          ))}
          <List.Item
            key="disable"
            title="Disable Camera"
            icon={Icon.EyeDisabled}
            actions={
              <ActionPanel>
                <Action
                  title="Disable Camera"
                  onAction={disableCamera}
                />
              </ActionPanel>
            }
          />
        </>
      )}
    </List>
  );
}
