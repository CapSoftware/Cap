/**
 * useDeeplinks
 *
 * Registers Tauri event listeners for all `cap://` deep-link routes and
 * translates them into recording-store / settings-store actions.
 *
 * Mount this hook once at the top of the app (e.g. in _app.tsx or a root
 * layout component).
 */
import { useEffect } from "react";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

// ---------------------------------------------------------------------------
// Type stubs – replace with your actual store imports
// ---------------------------------------------------------------------------
type RecordingStatus = "idle" | "recording" | "paused" | "stopping";

// We use window-level callbacks so the hook works with any state management
// solution (zustand, jotai, context, etc.).  Pass the appropriate handlers
// from your store.
export interface DeeplinkHandlers {
  onStartRecording: () => void | Promise<void>;
  onStopRecording: () => void | Promise<void>;
  onPauseRecording: () => void | Promise<void>;
  onResumeRecording: () => void | Promise<void>;
  onRestartRecording: () => void | Promise<void>;
  onScreenshot: () => void | Promise<void>;
  onSetMic: (deviceId: string | null) => void | Promise<void>;
  onSetCamera: (deviceId: string | null) => void | Promise<void>;
  onToggleCamera: () => void | Promise<void>;
  onSetMode: (mode: string | null) => void | Promise<void>;
  onStatusRequested: () => RecordingStatus;
}

export function useDeeplinks(handlers: DeeplinkHandlers) {
  useEffect(() => {
    const unlisten: UnlistenFn[] = [];

    async function register() {
      unlisten.push(
        await listen("deeplink-recording-start", async () => {
          console.log("[deeplink] start recording");
          await handlers.onStartRecording();
        })
      );

      unlisten.push(
        await listen("deeplink-recording-stop", async () => {
          console.log("[deeplink] stop recording");
          await handlers.onStopRecording();
        })
      );

      unlisten.push(
        await listen("deeplink-recording-pause", async () => {
          console.log("[deeplink] pause recording");
          await handlers.onPauseRecording();
        })
      );

      unlisten.push(
        await listen("deeplink-recording-resume", async () => {
          console.log("[deeplink] resume recording");
          await handlers.onResumeRecording();
        })
      );

      unlisten.push(
        await listen("deeplink-recording-restart", async () => {
          console.log("[deeplink] restart recording");
          await handlers.onRestartRecording();
        })
      );

      unlisten.push(
        await listen("deeplink-screenshot", async () => {
          console.log("[deeplink] screenshot");
          await handlers.onScreenshot();
        })
      );

      unlisten.push(
        await listen<string | null>("deeplink-mic-set", async (event) => {
          console.log("[deeplink] set mic", event.payload);
          await handlers.onSetMic(event.payload ?? null);
        })
      );

      unlisten.push(
        await listen<string | null>("deeplink-camera-set", async (event) => {
          console.log("[deeplink] set camera", event.payload);
          await handlers.onSetCamera(event.payload ?? null);
        })
      );

      unlisten.push(
        await listen("deeplink-camera-toggle", async () => {
          console.log("[deeplink] toggle camera");
          await handlers.onToggleCamera();
        })
      );

      unlisten.push(
        await listen<string | null>("deeplink-mode-set", async (event) => {
          console.log("[deeplink] set mode", event.payload);
          await handlers.onSetMode(event.payload ?? null);
        })
      );

      unlisten.push(
        await listen("deeplink-recording-status", async () => {
          const status = handlers.onStatusRequested();
          await invoke("emit_event", {
            event: "recording-status-response",
            payload: { status },
          }).catch(() => {
            // emit_event may not exist; ignore gracefully
          });
        })
      );
    }

    register().catch(console.error);

    return () => {
      unlisten.forEach((fn) => fn());
    };
    // handlers identity doesn't change between renders so this is safe
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
