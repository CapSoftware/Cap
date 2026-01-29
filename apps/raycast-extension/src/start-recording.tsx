import { Action, ActionPanel, Form, showToast, Toast, popToRoot } from "@raycast/api";
import { useState } from "react";
import * as deeplink from "./utils/deeplink";

interface FormValues {
    captureType: "screen" | "window";
    targetName: string;
    camera: boolean;
    microphone: boolean;
    systemAudio: boolean;
    mode: "Studio" | "Instant";
}

export default function Command() {
    const [isLoading, setIsLoading] = useState(false);

    async function handleSubmit(values: FormValues) {
        setIsLoading(true);
        try {
            const captureMode =
                values.captureType === "screen" ? { screen: values.targetName } : { window: values.targetName };

            await deeplink.startRecording({
                captureMode,
                camera: null,
                micLabel: null,
                captureSystemAudio: values.systemAudio,
                mode: values.mode,
            });

            await showToast({
                style: Toast.Style.Success,
                title: "Recording Started",
                message: `Recording ${values.targetName} in ${values.mode} mode`,
            });

            await popToRoot();
        } catch (error) {
            await showToast({
                style: Toast.Style.Failure,
                title: "Failed to Start Recording",
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
                    <Action.SubmitForm title="Start Recording" onSubmit={handleSubmit} />
                </ActionPanel>
            }
        >
            <Form.Dropdown id="captureType" title="Capture Type" defaultValue="screen">
                <Form.Dropdown.Item value="screen" title="Screen" />
                <Form.Dropdown.Item value="window" title="Window" />
            </Form.Dropdown>

            <Form.TextField
                id="targetName"
                title="Target Name"
                placeholder="Enter display or window name"
                info="Tip: Use 'List Displays' or 'List Windows' command to see available names"
            />

            <Form.Dropdown id="mode" title="Recording Mode" defaultValue="Studio">
                <Form.Dropdown.Item value="Studio" title="Studio Mode" />
                <Form.Dropdown.Item value="Instant" title="Instant Mode" />
            </Form.Dropdown>

            <Form.Separator />

            <Form.Checkbox id="camera" label="Enable Camera" defaultValue={false} />

            <Form.Checkbox id="microphone" label="Enable Microphone" defaultValue={true} />

            <Form.Checkbox id="systemAudio" label="Capture System Audio" defaultValue={false} />
        </Form>
    );
}
