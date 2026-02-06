import { showToast, Toast } from "@raycast/api";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

/**
 * Open a deep link URL in Cap
 */
export async function openDeepLink(url: string): Promise<void> {
  try {
    // Try using open command on macOS
    await execAsync(`open "${url}"`);
  } catch (error) {
    // Fallback: show error
    await showToast({
      style: Toast.Style.Failure,
      title: "Failed to open Cap",
      message: "Make sure Cap is installed",
    });
    throw error;
  }
}

/**
 * Generate deep link URL for Cap commands
 */
export function generateDeepLink(
  action: string,
  params?: Record<string, string>
): string {
  const url = new URL(`cap://${action}`);
  
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      url.searchParams.set(key, value);
    });
  }
  
  return url.toString();
}
