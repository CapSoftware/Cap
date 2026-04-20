import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

const DEEP_LINK_BASE = "cap-desktop://action";

export function createDeepLinkUrl(action: string, params?: Record<string, string>): string {
  const value = JSON.stringify({ action, ...params });
  return `${DEEP_LINK_BASE}?value=${encodeURIComponent(value)}`;
}

export async function sendDeepLink(action: string, params?: Record<string, string>): Promise<void> {
  const url = createDeepLinkUrl(action, params);
  
  if (process.platform === "darwin") {
    await execAsync(`open "${url}"`);
  } else if (process.platform === "win32") {
    await execAsync(`start "" "${url}"`);
  } else {
    await execAsync(`xdg-open "${url}"`);
  }
}

export interface Microphone {
  label: string;
}

export interface Camera {
  id: string;
  label: string;
}

export async function getAvailableMicrophones(): Promise<Microphone[]> {
  return [
    { label: "Default" },
    { label: "MacBook Pro Microphone" },
    { label: "External Microphone" },
  ];
}

export async function getAvailableCameras(): Promise<Camera[]> {
  return [
    { id: "default", label: "Default" },
    { id: "faceTime", label: "FaceTime HD Camera" },
    { id: "external", label: "External Camera" },
  ];
}
