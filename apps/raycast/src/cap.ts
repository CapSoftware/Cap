import { open, showHUD } from "@raycast/api";

const SCHEME = "cap-desktop://action";

export type QueryParams = Record<string, string | boolean | undefined>;

export async function openCapAction(action: string, params: QueryParams = {}) {
  const url = new URL(`${SCHEME}/${action}`);

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "")
      url.searchParams.set(key, String(value));
  }

  await open(url.toString());
}

export async function runNoViewAction(action: string, hudTitle: string) {
  await openCapAction(action);
  await showHUD(hudTitle);
}
