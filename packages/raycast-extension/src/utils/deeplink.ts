/**
 * Generate a deeplink for Cap recording control actions
 * 
 * Supported actions:
 * - pause_recording: {} (no params)
 * - resume_recording: {} (no params)
 * - stop_recording: {} (no params)
 * - start_recording: { capture_mode, camera?, mic_label?, capture_system_audio, mode }
 * - switch_camera: { device_id }
 * - switch_microphone: { mic_label }
 */
export const generateDeeplink = (action: string, params?: Record<string, any>): string => {
  const validActions = [
    "pause_recording",
    "resume_recording",
    "stop_recording",
    "start_recording",
    "switch_camera",
    "switch_microphone"
  ];

  if (!validActions.includes(action)) {
    throw new Error(`Invalid action: ${action}. Must be one of: ${validActions.join(", ")}`);
  }

  const url = new URL(`cap://action`);
  
  const actionObj: any = {};
  
  if (params) {
    actionObj[action] = params;
  } else {
    actionObj[action] = {};
  }
  
  url.searchParams.append("value", JSON.stringify(actionObj));
  return url.toString();
};
