import { LaunchProps, closeMainWindow, showHUD, showToast, Toast } from "@raycast/api";
import { runCapDeeplink } from "./deeplink";

type Args = {
  arguments: {
    target: string;
    mode: string;
    captureSystemAudio: string;
    micLabel: string;
    cameraJson: string;
  };
};

function parseCaptureMode(raw: string): { screen?: string; window?: string } | null {
  const t = raw.trim();
  const i = t.indexOf(":");
  if (i <= 0) return null;
  const k = t.slice(0, i).toLowerCase();
  const name = t.slice(i + 1).trim();
  if (!name) return null;
  if (k === "screen") return { screen: name };
  if (k === "window") return { window: name };
  return null;
}

function parseMode(m: string): "studio" | "instant" | null {
  const v = m.trim().toLowerCase();
  if (v === "studio" || v === "instant") return v;
  return null;
}

/** Empty → false (default). Recognized truthy/falsy only; garbage → error. */
function parseCaptureSystemAudio(raw: string | undefined): { ok: true; value: boolean } | { ok: false } {
  const s = (raw ?? "").trim();
  if (s.length === 0) return { ok: true, value: false };
  const v = s.toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return { ok: true, value: true };
  if (v === "0" || v === "false" || v === "no" || v === "off") return { ok: true, value: false };
  return { ok: false };
}

export default async function main(props: LaunchProps<Args>) {
  const capture_mode = parseCaptureMode(props.arguments.target);
  if (!capture_mode) {
    await showToast({
      style: Toast.Style.Failure,
      title: "target must be screen:Name or window:Name",
    });
    return;
  }
  const mode = parseMode(props.arguments.mode);
  if (!mode) {
    await showToast({
      style: Toast.Style.Failure,
      title: 'mode must be "studio" or "instant"',
    });
    return;
  }
  const mic = props.arguments.micLabel?.trim();
  const camRaw = props.arguments.cameraJson?.trim();
  let camera: unknown = null;
  if (camRaw) {
    try {
      camera = JSON.parse(camRaw) as unknown;
    } catch {
      await showToast({ style: Toast.Style.Failure, title: "cameraJson is not valid JSON" });
      return;
    }
  }
  const sysAudio = parseCaptureSystemAudio(props.arguments.captureSystemAudio);
  if (!sysAudio.ok) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Invalid captureSystemAudio",
      message: `Got "${props.arguments.captureSystemAudio ?? ""}". Use true/false, yes/no, on/off, or 1/0 (empty = false).`,
    });
    return;
  }
  const capture_system_audio = sysAudio.value;
  await runCapDeeplink({
    start_recording: {
      capture_mode,
      camera,
      mic_label: mic ? mic : null,
      capture_system_audio,
      mode,
    },
  });
  await showHUD("Cap: start recording");
  await closeMainWindow();
}
