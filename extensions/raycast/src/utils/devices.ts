import { exec } from "child_process";
import { promisify } from "util";
import { buildDeeplink } from "./deeplink";

const execAsync = promisify(exec);

interface MicrophoneInfo {
  label: string;
  is_default: boolean;
}

interface CameraInfo {
  id: string;
  name: string;
  is_default: boolean;
}

export async function getAvailableMicrophones(): Promise<string[]> {
  try {
    const deeplink = buildDeeplink({ list_microphones: {} });
    const { stdout } = await execAsync(`open "${deeplink}"`);
    
    await new Promise((resolve) => setTimeout(resolve, 500));
    
    const mics: MicrophoneInfo[] = JSON.parse(stdout.trim() || "[]");
    return mics.map((mic) => mic.label);
  } catch (error) {
    console.error("Failed to get microphones:", error);
    return [];
  }
}

export async function getAvailableCameras(): Promise<Array<{ id: string; name: string }>> {
  try {
    const deeplink = buildDeeplink({ list_cameras: {} });
    const { stdout } = await execAsync(`open "${deeplink}"`);
    
    await new Promise((resolve) => setTimeout(resolve, 500));
    
    const cameras: CameraInfo[] = JSON.parse(stdout.trim() || "[]");
    return cameras.map((camera) => ({ id: camera.id, name: camera.name }));
  } catch (error) {
    console.error("Failed to get cameras:", error);
    return [];
  }
}
