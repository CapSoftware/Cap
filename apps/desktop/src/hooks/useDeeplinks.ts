/**
 * useDeeplinks – renderer-side deeplink action consumer
 *
 * Usage:
 *   import { useDeeplinks } from "@/hooks/useDeeplinks";
 *
 *   function RecordingPage() {
 *     useDeeplinks();   // call once at the root of your recording UI
 *     ...
 *   }
 *
 * The hook listens for IPC "deeplink-action" events from the main process and
 * calls the appropriate recording-store actions.
 */

import { useEffect } from "react";

// ── Type shim for the Electron contextBridge API exposed by preload ──────────
declare global {
  interface Window {
    // Cap exposes ipcRenderer helpers via contextBridge in preload.ts
    // The exact shape depends on your preload – adapt as needed.
    ipcRenderer?: {
      on: (
        channel: string,
        listener: (event: unknown, ...args: unknown[]) => void
      ) => void;
      off: (
        channel: string,
        listener: (event: unknown, ...args: unknown[]) => void
      ) => void;
    };
  }
}

export interface DeeplinkPayload {
  action: string;
  params: Record<string, string>;
}

type DeeplinkListener = (payload: DeeplinkPayload) => void;

const listeners = new Set<DeeplinkListener>();

// Single global IPC subscription so we don't double-register
let _globalSubscribed = false;
function ensureGlobalSubscription() {
  if (_globalSubscribed) return;
  if (!window.ipcRenderer) return;
  _globalSubscribed = true;

  window.ipcRenderer.on(
    "deeplink-action",
    (_event: unknown, payload: DeeplinkPayload) => {
      listeners.forEach((fn) => fn(payload));
    }
  );
}

/**
 * Subscribe a callback to all incoming deeplink actions.
 * Returns an unsubscribe function.
 */
export function onDeeplinkAction(fn: DeeplinkListener): () => void {
  ensureGlobalSubscription();
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ── Recording context integration ────────────────────────────────────────────
// Adjust these imports to match your actual recording store / context.
// The hook is designed to be a thin adapter – it maps action strings to calls
// in whatever state management you already have.

/**
 * Drop-in hook.  Mount once inside the component tree that owns recording
 * state.  It maps deeplink action strings → your store's dispatch calls.
 *
 * @param handlers  Object mapping action strings to handler functions.
 *
 * Example:
 * ```tsx
 * useDeeplinks({
 *   "record/start":        () => startRecording(),
 *   "record/stop":         () => stopRecording(),
 *   "record/pause":        () => pauseRecording(),
 *   "record/resume":       () => resumeRecording(),
 *   "record/restart":      () => restartRecording(),
 *   "record/toggle":       () => isRecording ? stopRecording() : startRecording(),
 *   "record/toggle-pause": () => isPaused ? resumeRecording() : pauseRecording(),
 *   "settings/camera":     ({ params }) => switchCamera(params.deviceId),
 *   "settings/microphone": ({ params }) => switchMicrophone(params.deviceId),
 *   "settings/open":       () => navigate("/settings"),
 * });
 * ```
 */
export function useDeeplinks(
  handlers: Partial<Record<string, (payload: DeeplinkPayload) => void>>
): void {
  useEffect(() => {
    const unsubscribe = onDeeplinkAction((payload) => {
      const handler = handlers[payload.action];
      if (handler) {
        handler(payload);
      } else {
        console.warn("[useDeeplinks] No handler registered for:", payload.action);
      }
    });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
