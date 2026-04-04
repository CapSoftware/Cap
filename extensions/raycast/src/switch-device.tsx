// Fix for Issue #1540 - Deep Links & Raycast Support
//
// Command: switch-device
// Purpose: List available microphones and cameras, then switch Cap's active
//          input device by sending a deep link to the desktop app.
//
// Security:
//   - The Cap API key is stored in Raycast's LocalStorage, never hard-coded.
//   - If no key is stored the user is prompted to enter one.
//   - Device lists are fetched from the Cap API on demand.
//
// Deep links used:
//   SwitchMicrophone: cap-desktop://action?value={"type":"switchMicrophone","label":"<name>"}
//   SwitchCamera:     cap-desktop://action?value={"type":"switchCamera","id":"<deviceId>"}

import {
  Action,
  ActionPanel,
  Color,
  Form,
  Icon,
  List,
  LocalStorage,
  Toast,
  open,
  showToast,
  useNavigation,
} from "@raycast/api";
import { useEffect, useState } from "react";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_KEY_STORAGE_KEY = "cap_api_key";
const CAP_API_BASE = "https://api.cap.so/v1";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MicDevice {
  kind: "microphone";
  label: string;
  deviceId: string;
}

interface CameraDevice {
  kind: "camera";
  label: string;
  deviceId: string;
  modelId?: string;
}

type InputDevice = MicDevice | CameraDevice;

// We match the Rust enum tag names exactly.
type SwitchMicrophoneAction = { type: "switchMicrophone"; label: string | null };
type SwitchCameraAction = { type: "switchCamera"; id: string | null };

// ---------------------------------------------------------------------------
// Deep link builder (mirrors cap-control.tsx — kept local to avoid coupling)
// ---------------------------------------------------------------------------

function buildDeepLink(action: SwitchMicrophoneAction | SwitchCameraAction): string {
  return `cap-desktop://action?value=${encodeURIComponent(JSON.stringify(action))}`;
}

async function sendSwitch(device: InputDevice): Promise<void> {
  const action: SwitchMicrophoneAction | SwitchCameraAction =
    device.kind === "microphone"
      ? { type: "switchMicrophone", label: device.label }
      : { type: "switchCamera", id: device.deviceId };

  const url = buildDeepLink(action);

  try {
    await open(url);
    await showToast({
      style: Toast.Style.Success,
      title: `Cap — Switched ${device.kind === "microphone" ? "Microphone" : "Camera"}`,
      message: device.label,
    });
  } catch (error) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Cap — Switch Failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

// ---------------------------------------------------------------------------
// API helpers (fetches device lists from Cap's API using the stored key)
// ---------------------------------------------------------------------------

async function getStoredApiKey(): Promise<string | undefined> {
  try {
    return await LocalStorage.getItem<string>(API_KEY_STORAGE_KEY);
  } catch {
    return undefined;
  }
}

async function fetchDevices(apiKey: string): Promise<InputDevice[]> {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  const [micsRes, camsRes] = await Promise.all([
    fetch(`${CAP_API_BASE}/devices/microphones`, { headers }),
    fetch(`${CAP_API_BASE}/devices/cameras`, { headers }),
  ]);

  if (!micsRes.ok || !camsRes.ok) {
    throw new Error(
      `API error: microphones=${micsRes.status} cameras=${camsRes.status}`
    );
  }

  interface ApiMic {
    label: string;
    deviceId: string;
  }
  interface ApiCam {
    label: string;
    deviceId: string;
    modelId?: string;
  }

  const micsJson: { data: ApiMic[] } = await micsRes.json();
  const camsJson: { data: ApiCam[] } = await camsRes.json();

  const mics: MicDevice[] = (micsJson.data ?? []).map((m) => ({
    kind: "microphone" as const,
    label: m.label,
    deviceId: m.deviceId,
  }));

  const cams: CameraDevice[] = (camsJson.data ?? []).map((c) => ({
    kind: "camera" as const,
    label: c.label,
    deviceId: c.deviceId,
    modelId: c.modelId,
  }));

  return [...mics, ...cams];
}

// ---------------------------------------------------------------------------
// API Key setup form — shown when no key is stored
// ---------------------------------------------------------------------------

interface ApiKeyFormProps {
  onSaved: (key: string) => void;
}

function ApiKeyForm({ onSaved }: ApiKeyFormProps) {
  const [apiKey, setApiKey] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  async function handleSubmit() {
    const trimmed = apiKey.trim();
    if (!trimmed) {
      await showToast({ style: Toast.Style.Failure, title: "API key cannot be empty" });
      return;
    }
    setIsLoading(true);
    try {
      await LocalStorage.setItem(API_KEY_STORAGE_KEY, trimmed);
      await showToast({ style: Toast.Style.Success, title: "API key saved" });
      onSaved(trimmed);
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed to save API key",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <Form
      navigationTitle="Cap — Enter API Key"
      isLoading={isLoading}
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Save API Key" onSubmit={handleSubmit} />
        </ActionPanel>
      }
    >
      <Form.Description
        title="Cap API Key Required"
        text="Enter your Cap API key to fetch available input devices. You can find it in Cap Settings → Developer. The key is stored securely in Raycast's local storage and never leaves your device."
      />
      <Form.PasswordField
        id="apiKey"
        title="API Key"
        placeholder="cap_sk_…"
        value={apiKey}
        onChange={setApiKey}
      />
    </Form>
  );
}

// ---------------------------------------------------------------------------
// Main command component
// ---------------------------------------------------------------------------

export default function SwitchDeviceCommand() {
  const { push } = useNavigation();
  const [isLoading, setIsLoading] = useState(true);
  const [devices, setDevices] = useState<InputDevice[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function loadDevices(key?: string) {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const storedKey = key ?? (await getStoredApiKey());

      if (!storedKey) {
        // Navigate to the API key form — when saved it calls loadDevices again.
        push(<ApiKeyForm onSaved={(k) => loadDevices(k)} />);
        return;
      }

      const fetched = await fetchDevices(storedKey);
      setDevices(fetched);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setErrorMessage(msg);
      await showToast({
        style: Toast.Style.Failure,
        title: "Cap — Failed to load devices",
        message: msg,
      });
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    loadDevices();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const microphones = devices.filter((d): d is MicDevice => d.kind === "microphone");
  const cameras = devices.filter((d): d is CameraDevice => d.kind === "camera");

  async function handleDisableMic() {
    const action: SwitchMicrophoneAction = { type: "switchMicrophone", label: null };
    await open(buildDeepLink(action));
    await showToast({ style: Toast.Style.Success, title: "Cap — Microphone disabled" });
  }

  async function handleDisableCam() {
    const action: SwitchCameraAction = { type: "switchCamera", id: null };
    await open(buildDeepLink(action));
    await showToast({ style: Toast.Style.Success, title: "Cap — Camera disabled" });
  }

  return (
    <List
      isLoading={isLoading}
      navigationTitle="Cap — Switch Input Device"
      searchBarPlaceholder="Search microphones and cameras…"
    >
      {errorMessage && (
        <List.EmptyView
          icon={{ source: Icon.ExclamationMark, tintColor: Color.Red }}
          title="Could not load devices"
          description={errorMessage}
          actions={
            <ActionPanel>
              <Action title="Retry" icon={Icon.ArrowClockwise} onAction={() => loadDevices()} />
              <Action
                title="Reset API Key"
                icon={Icon.Trash}
                style={Action.Style.Destructive}
                onAction={async () => {
                  await LocalStorage.removeItem(API_KEY_STORAGE_KEY);
                  await loadDevices();
                }}
              />
            </ActionPanel>
          }
        />
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Microphones                                                          */}
      {/* ------------------------------------------------------------------ */}
      <List.Section title="Microphones" subtitle={`${microphones.length} available`}>
        {microphones.map((mic) => (
          <List.Item
            key={mic.deviceId}
            id={`mic-${mic.deviceId}`}
            title={mic.label}
            icon={{ source: Icon.Microphone, tintColor: Color.Blue }}
            accessories={[{ text: mic.deviceId }]}
            actions={
              <ActionPanel>
                <Action
                  title={`Use "${mic.label}"`}
                  icon={Icon.Microphone}
                  onAction={() => sendSwitch(mic)}
                />
                <Action.CopyToClipboard
                  title="Copy Deep Link"
                  content={buildDeepLink({ type: "switchMicrophone", label: mic.label })}
                  shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
                />
              </ActionPanel>
            }
          />
        ))}

        <List.Item
          key="mic-disable"
          id="mic-disable"
          title="Disable Microphone"
          subtitle="Mute / remove mic input"
          icon={{ source: Icon.MicrophoneDisabled, tintColor: Color.SecondaryText }}
          actions={
            <ActionPanel>
              <Action title="Disable Microphone" icon={Icon.MicrophoneDisabled} onAction={handleDisableMic} />
            </ActionPanel>
          }
        />
      </List.Section>

      {/* ------------------------------------------------------------------ */}
      {/* Cameras                                                              */}
      {/* ------------------------------------------------------------------ */}
      <List.Section title="Cameras" subtitle={`${cameras.length} available`}>
        {cameras.map((cam) => (
          <List.Item
            key={cam.deviceId}
            id={`cam-${cam.deviceId}`}
            title={cam.label}
            subtitle={cam.modelId}
            icon={{ source: Icon.Camera, tintColor: Color.Purple }}
            accessories={[{ text: cam.deviceId }]}
            actions={
              <ActionPanel>
                <Action
                  title={`Use "${cam.label}"`}
                  icon={Icon.Camera}
                  onAction={() => sendSwitch(cam)}
                />
                <Action.CopyToClipboard
                  title="Copy Deep Link"
                  content={buildDeepLink({ type: "switchCamera", id: cam.deviceId })}
                  shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
                />
              </ActionPanel>
            }
          />
        ))}

        <List.Item
          key="cam-disable"
          id="cam-disable"
          title="Disable Camera"
          subtitle="Remove camera overlay"
          icon={{ source: Icon.VideoDisabled, tintColor: Color.SecondaryText }}
          actions={
            <ActionPanel>
              <Action title="Disable Camera" icon={Icon.VideoDisabled} onAction={handleDisableCam} />
            </ActionPanel>
          }
        />
      </List.Section>

      {/* ------------------------------------------------------------------ */}
      {/* Settings                                                             */}
      {/* ------------------------------------------------------------------ */}
      <List.Section title="Settings">
        <List.Item
          id="settings-refresh"
          title="Refresh Device List"
          icon={{ source: Icon.ArrowClockwise, tintColor: Color.Blue }}
          actions={
            <ActionPanel>
              <Action title="Refresh" icon={Icon.ArrowClockwise} onAction={() => loadDevices()} />
            </ActionPanel>
          }
        />
        <List.Item
          id="settings-reset-key"
          title="Reset API Key"
          subtitle="Enter a new Cap API key"
          icon={{ source: Icon.Key, tintColor: Color.Red }}
          actions={
            <ActionPanel>
              <Action
                title="Reset API Key"
                style={Action.Style.Destructive}
                icon={Icon.Trash}
                onAction={async () => {
                  await LocalStorage.removeItem(API_KEY_STORAGE_KEY);
                  await loadDevices();
                }}
              />
            </ActionPanel>
          }
        />
      </List.Section>
    </List>
  );
}
