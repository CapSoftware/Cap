import { Action, ActionPanel, Form, showToast, Toast, popToRoot } from "@raycast/api";
import { useState } from "react";
import * as deeplink from "./utils/deeplink";

interface FormValues {
    microphoneName: string;
    enableMicrophone: boolean;
}

export default function Command() {
    const [isLoading, setIsLoading] = useState(false);

    async function handleSubmit(values: FormValues) {
        setIsLoading(true);
        try {
            const micLabel = values.enableMicrophone && values.microphoneName ? values.microphoneName : null;

            await deeplink.setMicrophone(micLabel);

            await showToast({
                style: Toast.Style.Success,
                title: values.enableMicrophone ? "Microphone Switched" : "Microphone Muted",
                message: values.enableMicrophone ? `Switched to: ${values.microphoneName}` : "Microphone has been muted",
            });

            await popToRoot();
        } catch (error) {
            await showToast({
                style: Toast.Style.Failure,
                title: "Failed to Switch Microphone",
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
                    <Action.SubmitForm title="Switch Microphone" onSubmit={handleSubmit} />
                </ActionPanel>
            }
        >
            <Form.Checkbox id="enableMicrophone" label="Enable Microphone" defaultValue={true} />

            <Form.TextField
                id="microphoneName"
                title="Microphone Name"
                placeholder="Enter microphone name"
                info="Tip: Use 'List Microphones' command to see available microphones"
            />
        </Form>
    );
}
