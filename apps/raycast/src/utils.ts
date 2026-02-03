import { open } from "@raycast/api";

const SCHEME = "cap-desktop://action?value=";

export function openCapDeepLink(payload: unknown) {
  const encoded = encodeURIComponent(JSON.stringify(payload));
  return open(`${SCHEME}${encoded}`);
}
