import { MenuBarExtra, open, showHUD } from "@raycast/api";
import { useCachedState } from "@raycast/utils";
import { useEffect } from "react";

export default function Command() {
  const [status, setStatus] = useCachedState<"idle" | "recording" | "paused">("recording-status", "idle");

  const sendAction = async (action: string, value: object = {}) => {
    const json = JSON.stringify({ [action]: value });
    const url = `cap://action?value=${encodeURIComponent(json)}`;
    await open(url);
    
    // Optimistic update for immediate feedback
    if (action === "stop_recording") setStatus("idle");
    if (action === "start_recording") setStatus("recording");
    if (action === "pause_recording") setStatus("paused");
    if (action === "resume_recording") setStatus("recording");
  };

  return (
    <MenuBarExtra
      icon={status === "recording" ? "🔴" : status === "paused" ? "⏸️" : "📷"}
      tooltip="Cap Recording Control"
    >
      {status === "idle" ? (
        <MenuBarExtra.Item
          title="Start Recording"
          onAction={() => sendAction("start_recording", { 
            capture_mode: { screen: "Display 1" },
            mode: "video",
            capture_system_audio: true
          })}
        />
      ) : (
        <>
          <MenuBarExtra.Item
            title="Stop Recording"
            onAction={() => sendAction("stop_recording")}
          />
          <MenuBarExtra.Item
            title={status === "paused" ? "Resume Recording" : "Pause Recording"}
            onAction={() => sendAction(status === "paused" ? "resume_recording" : "pause_recording")}
          />
        </>
      )}
      <MenuBarExtra.Separator />
      <MenuBarExtra.Item
        title="Open Settings"
        onAction={() => sendAction("open_settings")}
      />
    </MenuBarExtra>
  );
}
