import { open, showHUD } from "@raycast/api";

export async function sendCapCommand(action: string, objectValue?: Record<string, unknown>) {

  const valuePayload = objectValue 
    ? JSON.stringify({ [action]: objectValue }) 
    : `"${action}"`;
    
  const url = `cap://action?value=${encodeURIComponent(valuePayload)}`;
  try {
    await open(url);
    await showHUD(`Sent to Cap`);
  } catch (error) {
    await showHUD("Failed to communicate with Cap. Is it installed?");
    console.error(error);
  }
}
