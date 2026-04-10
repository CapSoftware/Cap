import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

const CAP_SCHEME = "cap";

/**
 * Open a Cap deeplink URL
 */
export async function openDeeplink(action: string, params?: Record<string, string | boolean | undefined>): Promise<void> {
  const url = new URL(`${CAP_SCHEME}://action`);
  
  if (params) {
    // Build the value JSON object
    const value: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(params)) {
      if (val !== undefined) {
        value[key] = val;
      }
    }
    // The action type is encoded in the JSON
    const actionObj: Record<string, unknown> = { [action]: value };
    url.searchParams.set("value", JSON.stringify(actionObj));
  } else {
    // No params, just the action
    url.searchParams.set("value", JSON.stringify({ [action]: {} }));
  }
  
  await execAsync(`open "${url.toString()}"`);
}

/**
 * Check if Cap is installed
 */
export async function isCapInstalled(): Promise<boolean> {
  try {
    await execAsync("which cap || ls /Applications/Cap.app");
    return true;
  } catch {
    return false;
  }
}

/**
 * Start a recording
 */
export async function startRecording(options?: {
  screen?: string;
  window?: string;
  camera?: string;
  microphone?: string;
  systemAudio?: boolean;
}): Promise<void> {
  const params: Record<string, string | boolean | undefined> = {};
  
  if (options?.screen) {
    params.capture_mode = { screen: options.screen };
  } else if (options?.window) {
    params.capture_mode = { window: options.window };
  }
  
  if (options?.camera) params.camera = options.camera;
  if (options?.microphone) params.mic_label = options.microphone;
  if (options?.systemAudio !== undefined) params.capture_system_audio = options.systemAudio;
  
  await openDeeplink("start_recording", params);
}

/**
 * Stop the current recording
 */
export async function stopRecording(): Promise<void> {
  await openDeeplink("stop_recording");
}

/**
 * Pause the current recording
 */
export async function pauseRecording(): Promise<void> {
  await openDeeplink("pause_recording");
}

/**
 * Resume a paused recording
 */
export async function resumeRecording(): Promise<void> {
  await openDeeplink("resume_recording");
}

/**
 * Set microphone input
 */
export async function setMicrophone(label?: string): Promise<void> {
  await openDeeplink("set_microphone", { mic_label: label });
}

/**
 * Set camera input
 */
export async function setCamera(camera?: string): Promise<void> {
  await openDeeplink("set_camera", { camera: camera ? { device_id: camera } : null });
}

/**
 * Open settings
 */
export async function openSettings(page?: string): Promise<void> {
  await openDeeplink("open_settings", { page });
}

/**
 * Open editor with a project
 */
export async function openEditor(projectPath: string): Promise<void> {
  await openDeeplink("open_editor", { project_path: projectPath });
}
