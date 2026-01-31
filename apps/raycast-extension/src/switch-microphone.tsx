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
      <List.Item
        title="Disable Microphone"
        subtitle="Turn off microphone input"
        actions={
          <ActionPanel>
            <Action
              title="Disable Microphone"
              onAction={() => handleSwitchMicrophone(null)}
            />
          </ActionPanel>
        }
      />
      <List.Section title="Quick Actions">
        <List.Item
          title="Enter Microphone Name"
          subtitle="Manually specify microphone name"
          actions={
            <ActionPanel>
              <Action
                title="Switch Microphone"
                onAction={async () => {
                  // In a real implementation, you'd show a form to enter the mic name
                  // For now, this is a placeholder
                  await showToast({
                    style: Toast.Style.Failure,
                    title: "Not implemented",
                    message: "Please use the deeplink directly with the microphone name",
                  });
                }}
              />
import { Action, ActionPanel, Form, open, showToast, Toast } from "@raycast/api";

type FormValues = {
  micLabel: string;
  disableMicrophone: boolean;
};

export default function Command() {
  const handleSubmit = async (values: FormValues) => {
    const micLabel = values.disableMicrophone ? null : values.micLabel.trim() || null;

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
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Switch Microphone"
            onSubmit={handleSubmit}
          />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="micLabel"
        title="Microphone Name"
        placeholder="e.g. MacBook Pro Microphone"
      />
      <Form.Checkbox
        id="disableMicrophone"
        title="Disable Microphone"
        label="Disable microphone input"
      />
    </Form>
  );
}
