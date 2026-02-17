import { closeMainWindow, showHUD } from "@raycast/api";
import { execFile } from "node:child_process";

function openUrl(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("open", [url], (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export async function triggerCapDeepLink(url: string, successMessage: string) {
  await openUrl(url);
  await closeMainWindow();
  await showHUD(successMessage);
}

export function buildUrl(
  path: string,
  params?: Record<string, string | undefined>,
) {
  const url = new URL(`cap-desktop://${path}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value && value.trim().length > 0) {
        url.searchParams.set(key, value);
      }
    }
  }
  return url.toString();
}
