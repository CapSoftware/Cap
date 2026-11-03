import { open } from "@raycast/api";

export interface StartRecordingOptions {
  mode?: "instant" | "studio";
  captureSystemAudio?: boolean;
  screenName?: string;
}

export function buildDeepLink(actionPayload: unknown): string {
  const value = JSON.stringify(actionPayload);
  return `cap://action?value=${encodeURIComponent(value)}`;
}

export async function triggerCapAction(actionPayload: unknown): Promise<void> {
  const url = buildDeepLink(actionPayload);
  try {
    await open(url);
  } catch {
    // Fallback to cap-desktop:// scheme
    const fallbackUrl = `cap-desktop://action?value=${encodeURIComponent(JSON.stringify(actionPayload))}`;
    await open(fallbackUrl);
  }
}
