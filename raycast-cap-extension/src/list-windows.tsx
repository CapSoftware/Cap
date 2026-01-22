import { List, open, showToast, Toast } from "@raycast/api";

export default async function Command() {
  try {
    const action = { list_windows: {} };
    const url = `cap-desktop://action?value=${encodeURIComponent(JSON.stringify(action))}`;
    await open(url);
    await showToast({ style: Toast.Style.Success, title: "Listing windows", message: "Check Cap app for window list" });
  } catch (error) {
    await showToast({ style: Toast.Style.Failure, title: "Failed to list windows", message: String(error) });
  }
  
  return <List><List.Item title="Window list sent to Cap app" /></List>;
}

