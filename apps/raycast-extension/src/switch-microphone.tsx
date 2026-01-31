import { List, ActionPanel, Action, showToast, Toast, open } from "@raycast/api";

export default function Command() {
  const isLoading = false;


  const handleSwitchMicrophone = async (micLabel: string | null) => {
    try {
      const action = {
        switch_microphone: {
          mic_label: micLabel,
        },
      };

      const url = `cap-desktop://action?value=${encodeURIComponent(JSON.stringify(action))}`;
      await open(url);
      await showToast({
        style: Toast.Style.Success,
        title: "Microphone switched",
        message: micLabel ? `Switched to ${micLabel}` : "Microphone disabled",
      });
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed to switch microphone",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  };

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder="Search or enter microphone name..."
      actions={
        <ActionPanel>
          <Action
            title="Disable Microphone"
            onAction={() => handleSwitchMicrophone(null)}
          />
        </ActionPanel>
      }
    >
import { Action, ActionPanel, Form, List, Toast, open, showToast } from "@raycast/api";
import { useState } from "react";

function buildActionUrl(action: unknown) {
  return `cap-desktop://action?value=${encodeURIComponent(JSON.stringify(action))}`;
}

async function switchMicrophone(micLabel: string | null) {
  const action = {
    switch_microphone: {
      mic_label: micLabel,
    },
  };

  try {
    await open(buildActionUrl(action));
    await showToast({
      style: Toast.Style.Success,
      title: micLabel ? "Microphone switched" : "Microphone disabled",
      message: micLabel ?? undefined,
    });
  } catch (error) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Failed to switch microphone",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

function MicLabelForm() {
  const [micLabel, setMicLabel] = useState("");

  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Switch Microphone"
            onSubmit={() => switchMicrophone(micLabel.trim() || null)}
          />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="micLabel"
        title="Microphone Name"
        value={micLabel}
        onChange={setMicLabel}
      />
    </Form>
  );
}

export default function Command() {
  return (
    <List searchBarPlaceholder="Microphone name...">
      <List.Item
        title="Disable Microphone"
        actions={
          <ActionPanel>
            <Action title="Disable Microphone" onAction={() => switchMicrophone(null)} />
          </ActionPanel>
        }
      />
      <List.Item
        title="Switch Microphone"
        actions={
          <ActionPanel>
            <Action.Push title="Enter Microphone Name" target={<MicLabelForm />} />
          </ActionPanel>
        }
      />
    </List>
  );
}
