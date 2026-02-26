import { buildDeeplink, DeeplinkAction } from "../utils/deeplink";

describe("Deeplink Builder", () => {
  test("builds pause recording deeplink", () => {
    const action: DeeplinkAction = { pause_recording: {} };
    const deeplink = buildDeeplink(action);
    
    expect(deeplink).toContain("cap-desktop://action?value=");
    expect(deeplink).toContain("pause_recording");
  });

  test("builds resume recording deeplink", () => {
    const action: DeeplinkAction = { resume_recording: {} };
    const deeplink = buildDeeplink(action);
    
    expect(deeplink).toContain("cap-desktop://action?value=");
    expect(deeplink).toContain("resume_recording");
  });

  test("builds toggle pause deeplink", () => {
    const action: DeeplinkAction = { toggle_pause_recording: {} };
    const deeplink = buildDeeplink(action);
    
    expect(deeplink).toContain("cap-desktop://action?value=");
    expect(deeplink).toContain("toggle_pause_recording");
  });

  test("builds stop recording deeplink", () => {
    const action: DeeplinkAction = { stop_recording: {} };
    const deeplink = buildDeeplink(action);
    
    expect(deeplink).toContain("cap-desktop://action?value=");
    expect(deeplink).toContain("stop_recording");
  });

  test("builds switch microphone deeplink", () => {
    const action: DeeplinkAction = { switch_microphone: { mic_label: "Test Mic" } };
    const deeplink = buildDeeplink(action);
    
    expect(deeplink).toContain("cap-desktop://action?value=");
    expect(deeplink).toContain("switch_microphone");
    expect(deeplink).toContain("Test%20Mic");
  });

  test("builds switch camera deeplink", () => {
    const action: DeeplinkAction = { switch_camera: { camera: { device_id: "test-camera" } } };
    const deeplink = buildDeeplink(action);
    
    expect(deeplink).toContain("cap-desktop://action?value=");
    expect(deeplink).toContain("switch_camera");
    expect(deeplink).toContain("test-camera");
  });

  test("builds list microphones deeplink", () => {
    const action: DeeplinkAction = { list_microphones: {} };
    const deeplink = buildDeeplink(action);
    
    expect(deeplink).toContain("cap-desktop://action?value=");
    expect(deeplink).toContain("list_microphones");
  });

  test("builds list cameras deeplink", () => {
    const action: DeeplinkAction = { list_cameras: {} };
    const deeplink = buildDeeplink(action);
    
    expect(deeplink).toContain("cap-desktop://action?value=");
    expect(deeplink).toContain("list_cameras");
  });

  test("URL encodes special characters", () => {
    const action: DeeplinkAction = { switch_microphone: { mic_label: "Test (Built-in)" } };
    const deeplink = buildDeeplink(action);
    
    expect(deeplink).not.toContain("(");
    expect(deeplink).not.toContain(")");
    expect(deeplink).toContain("%28");
    expect(deeplink).toContain("%29");
  });

  test("deeplink round-trip for pause recording", () => {
    const action: DeeplinkAction = { pause_recording: {} };
    const deeplink = buildDeeplink(action);
    
    const url = new URL(deeplink);
    const value = url.searchParams.get("value");
    expect(value).toBeTruthy();
    
    const decoded = decodeURIComponent(value!);
    const parsed = JSON.parse(decoded);
    
    expect(parsed).toHaveProperty("pause_recording");
  });

  test("deeplink round-trip for switch microphone", () => {
    const action: DeeplinkAction = { switch_microphone: { mic_label: "Test Mic" } };
    const deeplink = buildDeeplink(action);
    
    const url = new URL(deeplink);
    const value = url.searchParams.get("value");
    expect(value).toBeTruthy();
    
    const decoded = decodeURIComponent(value!);
    const parsed = JSON.parse(decoded);
    
    expect(parsed).toHaveProperty("switch_microphone");
    expect(parsed.switch_microphone.mic_label).toBe("Test Mic");
  });

  test("maintains snake_case in JSON", () => {
    const action: DeeplinkAction = { toggle_pause_recording: {} };
    const deeplink = buildDeeplink(action);
    
    const url = new URL(deeplink);
    const value = url.searchParams.get("value");
    const decoded = decodeURIComponent(value!);
    
    expect(decoded).toContain("toggle_pause_recording");
    expect(decoded).not.toContain("togglePauseRecording");
  });

  test("handles empty objects correctly", () => {
    const action: DeeplinkAction = { pause_recording: {} };
    const deeplink = buildDeeplink(action);
    
    const url = new URL(deeplink);
    const value = url.searchParams.get("value");
    const decoded = decodeURIComponent(value!);
    const parsed = JSON.parse(decoded);
    
    expect(parsed.pause_recording).toEqual({});
  });
});
