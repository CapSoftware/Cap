import { List, open, showToast, Toast } from "@raycast/api";

export default async function Command() {
  try {
    const action = { list_displays: {} };
    const url = `cap-desktop://action?value=${encodeURIComponent(JSON.stringify(action))}`;
    await open(url);
    await showToast({ style: Toast.Style.Success, title: "Listing displays", message: "Check Cap app for display list" });
  } catch (error) {
    await showToast({ style: Toast.Style.Failure, title: "Failed to list displays", message: String(error) });
  }
  
  return <List><List.Item title="Display list sent to Cap app" /></List>;
}

