import { open, showHUD } from "@raycast/api";

export async function sendCapCommand(action: string, objectValue?: Record<string, unknown>) {
  // If no object value is passed, it represents a simple unit enum variant.
  // Rust expects: "stop_recording"
  // If an object is passed, Rust expects: {"switch_microphone": {"mic_label": "mic"}}
  const valuePayload = objectValue 
    ? JSON.stringify({ [action]: objectValue }) 
    : `"${action}"`;
    
  const url = `cap://action?value=${encodeURIComponent(valuePayload)}`;
  try {
    await open(url);
    await showHUD(`Cap: Action Executed`);
  } catch (error) {
    await showHUD("Failed to communicate with Cap. Is it installed?");
    console.error(error);
  }
}
