export const generateDeeplink = (action: string, params?: Record<string, string>): string => {
  const url = new URL(`cap://action`);
  
  const actionObj: any = { [action]: {} };
  
  if (action === "switch_camera" && params?.device_id) {
    actionObj.switch_camera = { device_id: params.device_id };
  } else if (action === "switch_microphone" && params?.mic_label) {
    actionObj.switch_microphone = { mic_label: params.mic_label };
  }
  
  url.searchParams.append("value", JSON.stringify(actionObj));
  return url.toString();
};
