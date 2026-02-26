import { List, ActionPanel, Action, showToast, Toast, open } from "@raycast/api";
import { useState, useEffect } from "react";
import { getAvailableMicrophones } from "./utils/devices";
import { buildDeeplink } from "./utils/deeplink";

export default function Command() {
  const [microphones, setMicrophones] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    getAvailableMicrophones()
      .then(setMicrophones)
      .catch((error) => {
        showToast({
          style: Toast.Style.Failure,
          title: "Failed to load microphones",
          message: String(error),
        });
      })
      .finally(() => setIsLoading(false));
  }, []);

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Search microphones...">
      {microphones.length === 0 && !isLoading && (
        <List.EmptyView title="No microphones available" description="Make sure Cap has microphone permissions" />
      )}
      {microphones.map((mic) => (
        <List.Item
          key={mic}
          title={mic}
          actions={
            <ActionPanel>
              <Action
                title="Switch to This Microphone"
                onAction={async () => {
                  try {
                    const deeplink = buildDeeplink({
                      switch_microphone: { mic_label: mic },
                    });
                    await open(deeplink);
                    await showToast({
                      style: Toast.Style.Success,
                      title: `Switched to ${mic}`,
                    });
                  } catch (error) {
                    await showToast({
                      style: Toast.Style.Failure,
                      title: "Failed to switch microphone",
                      message: String(error),
                    });
                  }
                }}
              />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
