import { List, open, showToast, Toast } from "@raycast/api";

export default async function Command() {
  try {
    const action = { list_cameras: {} };
    const url = `cap-desktop://action?value=${encodeURIComponent(JSON.stringify(action))}`;
    await open(url);
    await showToast({ style: Toast.Style.Success, title: "Listing cameras", message: "Check Cap app for camera list" });
  } catch (error) {
    await showToast({ style: Toast.Style.Failure, title: "Failed to list cameras", message: String(error) });
  }
  
  return <List><List.Item title="Camera list sent to Cap app" /></List>;
}

