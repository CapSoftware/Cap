import {
	ActionSheetIOS,
	Alert,
	type AlertButton,
	Platform,
} from "react-native";
import type { MobileApiClient, MobileCapSummary } from "@/api/mobile";
import { colors } from "@/theme";

type CapPasswordActionsInput = {
	cap: MobileCapSummary;
	client: MobileApiClient;
	onUpdated: (cap: MobileCapSummary) => void | Promise<void>;
};

const getPasswordErrorMessage = (error: unknown) =>
	error instanceof Error ? error.message : "Unable to update this password.";

const savePassword = async ({
	cap,
	client,
	onUpdated,
	password,
}: CapPasswordActionsInput & { password: string | null }) => {
	try {
		const updated = await client.updateCapPassword(cap.id, { password });
		await onUpdated(updated);
	} catch (error) {
		Alert.alert("Password update failed", getPasswordErrorMessage(error));
	}
};

const promptForPassword = (input: CapPasswordActionsInput) => {
	const title = input.cap.protected ? "Change password" : "Add password";

	if (Platform.OS !== "ios") {
		Alert.alert("Password", "Password editing is available on iOS.");
		return;
	}

	Alert.prompt(
		title,
		"Set a password for this Cap link.",
		[
			{ text: "Cancel", style: "cancel" },
			{
				text: "Save",
				onPress: (value?: string) => {
					const password = value?.trim() ?? "";
					if (!password) {
						Alert.alert("Password required", "Enter a password for this Cap.");
						return;
					}
					void savePassword({ ...input, password });
				},
			},
		],
		"secure-text",
	);
};

export const showCapPasswordActions = (input: CapPasswordActionsInput) => {
	if (!input.cap.protected) {
		promptForPassword(input);
		return;
	}

	if (Platform.OS === "ios") {
		ActionSheetIOS.showActionSheetWithOptions(
			{
				cancelButtonIndex: 2,
				destructiveButtonIndex: 1,
				options: ["Change password", "Remove password", "Cancel"],
				title: "Password protected",
				tintColor: colors.blue11,
				userInterfaceStyle: "light",
			},
			(index) => {
				if (index === 0) promptForPassword(input);
				if (index === 1) void savePassword({ ...input, password: null });
			},
		);
		return;
	}

	const buttons: AlertButton[] = [
		{
			text: "Remove password",
			style: "destructive",
			onPress: () => {
				void savePassword({ ...input, password: null });
			},
		},
		{ text: "Cancel", style: "cancel" },
	];
	Alert.alert("Password protected", undefined, buttons);
};
