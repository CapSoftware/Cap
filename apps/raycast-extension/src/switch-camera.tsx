import { Action, ActionPanel, Form, showToast, Toast, popToRoot } from "@raycast/api";
import { useState } from "react";
import * as deeplink from "./utils/deeplink";

interface FormValues {
    cameraId: string;
    enableCamera: boolean;
}

export default function Command() {
    const [isLoading, setIsLoading] = useState(false);

    async function handleSubmit(values: FormValues) {
        setIsLoading(true);
        try {
            const cameraDevice = values.enableCamera && values.cameraId ? { Device: values.cameraId } : null;

            await deeplink.setCamera(cameraDevice);

            await showToast({
                style: Toast.Style.Success,
                title: values.enableCamera ? "Camera Switched" : "Camera Disabled",
                message: values.enableCamera ? `Switched to camera: ${values.cameraId}` : "Camera has been disabled",
            });

            await popToRoot();
        } catch (error) {
            await showToast({
                style: Toast.Style.Failure,
                title: "Failed to Switch Camera",
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
                    <Action.SubmitForm title="Switch Camera" onSubmit={handleSubmit} />
                </ActionPanel>
            }
        >
            <Form.Checkbox id="enableCamera" label="Enable Camera" defaultValue={true} />

            <Form.TextField
                id="cameraId"
                title="Camera ID"
                placeholder="Enter camera device ID"
                info="Tip: Use 'List Cameras' command to see available cameras and their IDs"
            />
        </Form>
    );
}
