import { open } from "@raycast/api";

type CapAction =
  | string
  | { switch_mic: { mic_label: string } }
  | { switch_camera: { camera_id: { DeviceID: string } | { ModelID: string } } };

export async function executeCapAction(action: CapAction) {
  const json = JSON.stringify(action);
  const url = `cap://action?value=${encodeURIComponent(json)}`;
  await open(url);
}
