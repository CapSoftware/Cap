import { Action, ActionPanel, Form, showToast, Toast, popToRoot } from "@raycast/api";
import { useState } from "react";
import * as deeplink from "./utils/deeplink";

interface FormValues {
    captureType: "screen" | "window";
    targetName: string;
}

export default function Command() {
    const [isLoading, setIsLoading] = useState(false);

    async function handleSubmit(values: FormValues) {
        setIsLoading(true);
        try {
            const captureTarget =
                values.captureType === "screen"
                    ? { display: { id: values.targetName } }
                    : { window: { id: values.targetName } };

            await deeplink.takeScreenshot(captureTarget);

            await showToast({
                style: Toast.Style.Success,
                title: "Screenshot Captured",
                message: `Screenshot of ${values.targetName} saved`,
            });

            await popToRoot();
        } catch (error) {
            await showToast({
                style: Toast.Style.Failure,
                title: "Failed to Take Screenshot",
                message: error instanceof Error ? error.message : "Unknown error occurred",
            });
        } finally {
            setIsLoading(false);
        }
    }

    return (
        <Form
            isLoading={isLoading}
            actions={
                <ActionPanel>
                    <Action.SubmitForm title="Take Screenshot" onSubmit={handleSubmit} />
                </ActionPanel>
            }
        >
            <Form.Dropdown id="captureType" title="Capture Type" defaultValue="screen">
                <Form.Dropdown.Item value="screen" title="Screen" />
                <Form.Dropdown.Item value="window" title="Window" />
            </Form.Dropdown>

            <Form.TextField
                id="targetName"
                title="Target ID"
                placeholder="Enter display or window ID"
                info="Tip: Use 'List Displays' or 'List Windows' command to get IDs"
            />
        </Form>
    );
}
