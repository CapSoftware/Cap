import { Action, ActionPanel, Detail, Icon } from "@raycast/api";
import { useEffect, useState } from "react";
import {
  RecordingStatus,
  capNotInstalled,
  createGetStatusAction,
  createStopRecordingAction,
  createTogglePauseAction,
  createRestartRecordingAction,
  executeCapAction,
  executeCapActionWithResponse,
} from "./utils";

export default function Command() {
  const [status, setStatus] = useState<RecordingStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function fetchStatus() {
    setIsLoading(true);
    setError(null);

    if (await capNotInstalled()) {
      setError("Cap is not installed");
      setIsLoading(false);
      return;
    }

    const result = await executeCapActionWithResponse<RecordingStatus>(createGetStatusAction());

    if (result) {
      setStatus(result);
    } else {
      setError("Could not get status from Cap. Make sure the app is running.");
    }
    setIsLoading(false);
  }

  useEffect(() => {
    fetchStatus();
  }, []);

  const statusIcon = status?.is_recording
    ? status.is_paused
      ? Icon.Pause
      : Icon.Video
    : Icon.Circle;

  const statusText = status?.is_recording
    ? status.is_paused
      ? "⏸ Paused"
      : "🔴 Recording"
    : "⚪ Idle";

  const modeText = status?.recording_mode
    ? status.recording_mode.charAt(0).toUpperCase() + status.recording_mode.slice(1)
    : "N/A";

  const markdown = error
    ? `# ❌ Error\n\n${error}`
    : `# Cap Recording Status\n\n| Property | Value |\n|----------|-------|\n| **Status** | ${statusText} |\n| **Mode** | ${modeText} |\n`;

  return (
    <Detail
      isLoading={isLoading}
      markdown={markdown}
      actions={
        !error && status ? (
          <ActionPanel>
            <Action title="Refresh" icon={Icon.ArrowClockwise} onAction={fetchStatus} />
            {status.is_recording && (
              <>
                <Action
                  title={status.is_paused ? "Resume Recording" : "Pause Recording"}
                  icon={status.is_paused ? Icon.Play : Icon.Pause}
                  onAction={async () => {
                    await executeCapAction(createTogglePauseAction(), {
                      feedbackMessage: status.is_paused ? "Resuming..." : "Pausing...",
                      feedbackType: "hud",
                    });
                    setTimeout(fetchStatus, 500);
                  }}
                />
                <Action
                  title="Stop Recording"
                  icon={Icon.Stop}
                  style={Action.Style.Destructive}
                  onAction={async () => {
                    await executeCapAction(createStopRecordingAction(), {
                      feedbackMessage: "Stopping recording...",
                      feedbackType: "hud",
                    });
                    setTimeout(fetchStatus, 1000);
                  }}
                />
                <Action
                  title="Restart Recording"
                  icon={Icon.RotateAntiClockwise}
                  onAction={async () => {
                    await executeCapAction(createRestartRecordingAction(), {
                      feedbackMessage: "Restarting recording...",
                      feedbackType: "hud",
                    });
                    setTimeout(fetchStatus, 1000);
                  }}
                />
              </>
            )}
          </ActionPanel>
        ) : (
          <ActionPanel>
            <Action title="Refresh" icon={Icon.ArrowClockwise} onAction={fetchStatus} />
          </ActionPanel>
        )
      }
    />
  );
}
