import { List, open, showToast, Toast } from "@raycast/api";

export default async function Command() {
  try {
    const action = { list_microphones: {} };
    const url = `cap-desktop://action?value=${encodeURIComponent(JSON.stringify(action))}`;
    await open(url);
    await showToast({ style: Toast.Style.Success, title: "Listing microphones", message: "Check Cap app for microphone list" });
  } catch (error) {
    await showToast({ style: Toast.Style.Failure, title: "Failed to list microphones", message: String(error) });
  }
  
  return <List><List.Item title="Microphone list sent to Cap app" /></List>;
}

