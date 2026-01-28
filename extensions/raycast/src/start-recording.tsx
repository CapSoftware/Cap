import { ActionPanel, Action, List, showToast, Toast } from "@raycast/api";
import { executeCapAction, RecordingMode } from "./utils";

export default function Command() {
  const captureOptions = [
    { title: "Full Screen", value: "screen" },
    { title: "Window", value: "window" },
  ];

  const recordingModes: { title: string; value: RecordingMode }[] = [
    { title: "Studio Mode", value: "studio" },
    { title: "Instant Mode", value: "instant" },
  ];

  async function startRecording(
    captureType: "screen" | "window",
    mode: RecordingMode,
    captureSystemAudio: boolean
  ) {
    try {
      await showToast({
        style: Toast.Style.Animated,
        title: "Starting recording...",
      });

      // For simplicity, using default screen/window
      // In a real implementation, you'd want to list available screens/windows
      const capture_mode =
        captureType === "screen"
          ? { screen: "Default Screen" }
          : { window: "Default Window" };

      await executeCapAction({
        start_recording: {
          capture_mode,
          capture_system_audio: captureSystemAudio,
          mode,
        },
      });

      await showToast({
        style: Toast.Style.Success,
        title: "Recording started",
      });
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed to start recording",
        message: String(error),
      });
    }
  }

  return (
    <List>
      {captureOptions.map((captureOption) =>
        recordingModes.map((mode) => (
          <List.Item
            key={`${captureOption.value}-${mode.value}`}
            title={`${captureOption.title} - ${mode.title}`}
            actions={
              <ActionPanel>
                <Action
                  title="Start Recording"
                  onAction={() =>
                    startRecording(
                      captureOption.value as "screen" | "window",
                      mode.value,
                      false
                    )
                  }
                />
                <Action
                  title="Start Recording (with System Audio)"
                  onAction={() =>
                    startRecording(
                      captureOption.value as "screen" | "window",
                      mode.value,
                      true
                    )
                  }
                />
              </ActionPanel>
            }
          />
        ))
      )}
    </List>
  );
}
