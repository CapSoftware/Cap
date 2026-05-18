import { Action, ActionPanel, Icon, List, showToast, Toast } from "@raycast/api";
import { sendDeepLink } from "./deeplink";

export default function SwitchCameraCommand() {
  return (
    <List>
      <List.Section title="Select Camera">
        {[
          { id: "default", label: "Default" },
          { id: "faceTime", label: "FaceTime HD Camera" },
          { id: "external", label: "External Camera" },
        ].map((camera) => (
          <List.Item
            key={camera.id}
            title={camera.label}
            icon={Icon.Camera}
            actions={
              <ActionPanel>
                <Action
                  title="Switch to This Camera"
                  icon={Icon.Checkmark}
                  onAction={async () => {
                    try {
                      await showToast({
                        style: Toast.Style.Animated,
                        title: `Switching to ${camera.label}...`,
                      });
                      
                      await sendDeepLink("switch_camera", { camera_id: camera.id });
                      
                      await showToast({
                        style: Toast.Style.Success,
                        title: `Switched to ${camera.label}`,
                      });
                    } catch (error) {
                      await showToast({
                        style: Toast.Style.Failure,
                        title: "Failed to Switch Camera",
                        message: error instanceof Error ? error.message : "Unknown error",
                      });
                    }
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
