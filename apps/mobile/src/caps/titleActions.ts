import { Alert, Platform } from "react-native";
import type { MobileApiClient, MobileCapSummary } from "@/api/mobile";

type CapTitleActionsInput = {
	cap: MobileCapSummary;
	client: MobileApiClient;
	onUpdated: (cap: MobileCapSummary) => void | Promise<void>;
};

const getTitleErrorMessage = (error: unknown) =>
	error instanceof Error ? error.message : "Unable to rename this Cap.";

const saveTitle = async ({
	cap,
	client,
	onUpdated,
	title,
}: CapTitleActionsInput & { title: string }) => {
	try {
		const updated = await client.updateCapTitle(cap.id, { title });
		await onUpdated(updated);
	} catch (error) {
		Alert.alert("Rename failed", getTitleErrorMessage(error));
	}
};

export const showCapTitleActions = (input: CapTitleActionsInput) => {
	if (Platform.OS !== "ios") {
		Alert.alert("Rename Cap", "Title editing is available on iOS.");
		return;
	}

	Alert.prompt(
		"Rename Cap",
		undefined,
		[
			{ text: "Cancel", style: "cancel" },
			{
				text: "Save",
				onPress: (value?: string) => {
					const title = value?.trim() ?? "";
					if (!title) {
						Alert.alert("Title required", "Enter a title for this Cap.");
						return;
					}
					void saveTitle({ ...input, title });
				},
			},
		],
		"plain-text",
		input.cap.title,
	);
};
