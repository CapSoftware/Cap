import { open, showHUD } from "@raycast/api";

/** All supported Cap deep-link actions */
export type CapAction =
  | "record/start"
  | "record/stop"
  | "record/pause"
  | "record/resume"
  | "record/restart"
  | "screenshot"
  | "window/main";

/**
 * Build a `cap://` deep-link URL.
 *
 * Examples:
 *   buildDeepLink("record/start")        → "cap://record/start"
 *   buildDeepLink("mic/set", { name })   → "cap://mic/set?name=My+Mic"
 */
export function buildDeepLink(
  path: string,
  params?: Record<string, string>
): string {
  const [host, ...rest] = path.split("/");
  const pathPart = rest.length ? `/${rest.join("/")}` : "";
  const base = `cap://${host}${pathPart}`;

  if (!params || Object.keys(params).length === 0) return base;

  const qs = new URLSearchParams(params).toString();
  return `${base}?${qs}`;
}

/**
 * Fire a Cap deep-link and show a HUD confirmation.
 */
export async function triggerCapAction(
  path: string,
  hudMessage: string,
  params?: Record<string, string>
): Promise<void> {
  const url = buildDeepLink(path, params);
  await open(url);
  await showHUD(hudMessage);
}
