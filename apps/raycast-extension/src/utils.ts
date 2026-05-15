import { open } from "@raycast/api";

export async function executeCapAction(action: any) {
  const json = JSON.stringify(action);
  const url = `cap://action?value=${encodeURIComponent(json)}`;
  await open(url);
}
