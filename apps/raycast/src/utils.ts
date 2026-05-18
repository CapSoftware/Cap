import { open, showHUD } from "@raycast/api";

const CAP_SCHEME = "cap-desktop://";

/**
 * Open a path-based Cap deeplink.
 *
 * @param path - Route path, e.g. "record/stop"
 * @param params - Optional query parameters
 */
export async function executeDeepLink(
  path: string,
  params?: Record<string, string>,
): Promise<void> {
  const url = new URL(`${CAP_SCHEME}${path}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }

  try {
    await open(url.toString());
  } catch {
    await showHUD("❌ Failed to connect to Cap. Is it running?");
    throw new Error("Could not open Cap deeplink");
  }
}

/**
 * Parse the output of `system_profiler SPAudioDataType` to extract input device names.
 */
export function parseMicrophoneNames(output: string): string[] {
  const names: string[] = [];
  const lines = output.split("\n");

  let inInputSection = false;
  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === "Input:") {
      inInputSection = true;
      continue;
    }
    if (trimmed === "Output:" || trimmed === "") {
      if (inInputSection && names.length > 0) break;
      inInputSection = false;
      continue;
    }

    if (inInputSection && trimmed.endsWith(":") && !trimmed.startsWith("Default")) {
      names.push(trimmed.slice(0, -1));
    }
  }

  return names;
}

/**
 * Parse `system_profiler SPCameraDataType` to extract camera names and unique IDs.
 */
export function parseCameras(
  output: string,
): { name: string; uniqueId: string }[] {
  const cameras: { name: string; uniqueId: string }[] = [];
  const lines = output.split("\n");

  let currentName: string | null = null;
  for (const line of lines) {
    const trimmed = line.trim();

    // Camera names appear as "Name: value" lines, or as section headers ending with ":"
    if (trimmed.startsWith("Unique ID:")) {
      const uniqueId = trimmed.replace("Unique ID:", "").trim();
      if (currentName && uniqueId) {
        cameras.push({ name: currentName, uniqueId });
      }
      currentName = null;
    } else if (
      trimmed.endsWith(":") &&
      !trimmed.startsWith("Cameras") &&
      !trimmed.startsWith("Model") &&
      !trimmed.startsWith("Unique")
    ) {
      currentName = trimmed.slice(0, -1);
    }
  }

  return cameras;
}

/**
 * Parse `system_profiler SPDisplaysDataType` to extract display names.
 */
export function parseDisplayNames(output: string): string[] {
  const names: string[] = [];
  const lines = output.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    // Display names appear as section headers (indented, ending with ":")
    // but not the GPU name lines
    if (
      trimmed.endsWith(":") &&
      !trimmed.includes("Chipset") &&
      !trimmed.includes("Displays") &&
      !trimmed.includes("Graphics") &&
      !trimmed.includes("Metal") &&
      line.startsWith("          ") // display names are deeply indented
    ) {
      names.push(trimmed.slice(0, -1));
    }
  }

  return names;
}
