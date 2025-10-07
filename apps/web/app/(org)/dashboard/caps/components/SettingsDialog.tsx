import {
	Button,
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	Switch,
} from "@cap/ui";
import { userIsPro } from "@cap/utils";
import type { Video } from "@cap/web-domain";
import { faGear } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import clsx from "clsx";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { updateVideoSettings } from "@/actions/videos/settings";
import { useDashboardContext } from "../../Contexts";
import type { OrganizationSettings } from "../../dashboard-data";

interface SettingsDialogProps {
	isOpen: boolean;
	onClose: () => void;
	capId: Video.VideoId;
	settingsData?: OrganizationSettings;
}

const options = [
	{
		label: "Disable comments",
		value: "disableComments",
		description: "Allow viewers to comment on this cap",
	},
	{
		label: "Disable summary",
		value: "disableSummary",
		description: "Remove the summary for this cap (requires transcript)",
		pro: true,
	},
	{
		label: "Disable captions",
		value: "disableCaptions",
		description: "Allow viewers to use captions for this cap",
	},
	{
		label: "Disable chapters",
		value: "disableChapters",
		description: "Remove the chapters for this cap (requires transcript)",
		pro: true,
	},
	{
		label: "Disable reactions",
		value: "disableReactions",
		description: "Allow viewers to react to this cap",
	},
	{
		label: "Disable transcript",
		value: "disableTranscript",
		description: "This also allows chapters and summary",
		pro: true,
	},
];

export const SettingsDialog = ({
	isOpen,
	onClose,
	capId,
	settingsData,
}: SettingsDialogProps) => {
	const { user, organizationSettings } = useDashboardContext();
	const [saveLoading, setSaveLoading] = useState(false);
	const [settings, setSettings] = useState<OrganizationSettings>({
		disableComments: settingsData?.disableComments,
		disableSummary: settingsData?.disableSummary,
		disableCaptions: settingsData?.disableCaptions,
		disableChapters: settingsData?.disableChapters,
		disableReactions: settingsData?.disableReactions,
		disableTranscript: settingsData?.disableTranscript,
	});

	const isUserPro = userIsPro(user);

	const saveHandler = async () => {
		setSaveLoading(true);
		if (!settings) return;
		try {
			await updateVideoSettings(capId, settings);
			toast.success("Settings updated successfully");
		} catch (error) {
			console.error("Error updating video settings:", error);
			toast.error("Failed to update settings");
		} finally {
			setSaveLoading(false);
		}
		onClose();
	};

	const toggleSettingHandler = useCallback(
		(value: string) => {
			setSettings((prev) => {
				const key = value as keyof OrganizationSettings;
				const currentValue = prev?.[key];
				const orgValue = organizationSettings?.[key] ?? false;

				// If using org default, set to opposite of org value
				// If org disabled it (true), enabling means setting to false
				// If org enabled it (false), disabling means setting to true
				const newValue = currentValue === undefined ? !orgValue : !currentValue;

				// If disabling transcript, also disable summary and chapters since they depend on it
				if (key === "disableTranscript" && newValue === true) {
					return {
						...prev,
						[key]: newValue,
						disableSummary: true,
						disableChapters: true,
					};
				}

				return {
					...prev,
					[key]: newValue,
				};
			});
		},
		[organizationSettings],
	);

	// Helper to get the effective value (considering org defaults)
	const getEffectiveValue = (key: keyof OrganizationSettings) => {
		const videoValue = settings?.[key];
		const orgValue = organizationSettings?.[key] ?? false;
		return videoValue !== undefined || videoValue === true
			? videoValue
			: orgValue;
	};

	return (
		<Dialog open={isOpen} onOpenChange={onClose}>
			<DialogContent className="max-w-md min-w-fit">
				<DialogHeader
					description="Manage the settings for this cap"
					icon={<FontAwesomeIcon icon={faGear} className="size-3.5" />}
				>
					<DialogTitle>Settings</DialogTitle>
				</DialogHeader>
				<div className="grid grid-cols-2 gap-3 p-5">
					{options.map((option) => {
						const key = option.value as keyof OrganizationSettings;
						const effectiveValue = getEffectiveValue(key);
						const orgValue = organizationSettings?.[key] ?? false;
						return (
							<div
								key={option.value}
								className="flex gap-10 justify-between items-center p-4 rounded-xl border transition-colors min-w-fit border-gray-3 bg-gray-1"
							>
								<div
									className={clsx(
										"flex flex-col flex-1",
										option.pro && "gap-1",
									)}
								>
									<div className="flex gap-1.5 items-center flex-wrap">
										<p className="text-sm text-gray-12">
											{option.label.replace("Disable", "Enable")}
										</p>
										{option.pro && (
											<p className="py-1 px-1.5 text-[10px] leading-none font-medium rounded-full text-gray-12 bg-blue-11">
												Pro
											</p>
										)}
										{effectiveValue && (
											<p className="py-1 px-1.5 text-[10px] leading-none font-medium rounded-full text-gray-11 bg-gray-5">
												Org {orgValue ? "disabled" : "enabled"}
											</p>
										)}
									</div>
									<p className="text-xs text-gray-10">{option.description}</p>
								</div>
								<Switch
									disabled={
										(option.pro && !isUserPro) ||
										// Disable summary and chapters if transcript is disabled
										((key === "disableSummary" || key === "disableChapters") &&
											getEffectiveValue(
												"disableTranscript" as keyof OrganizationSettings,
											))
									}
									onCheckedChange={() => toggleSettingHandler(option.value)}
									checked={!effectiveValue}
								/>
							</div>
						);
					})}
				</div>
				<DialogFooter className="p-5 border-t border-gray-4">
					<Button
						variant="gray"
						size="sm"
						onClick={onClose}
						disabled={saveLoading}
					>
						Cancel
					</Button>
					<Button
						variant="dark"
						size="sm"
						onClick={saveHandler}
						spinner={saveLoading}
						disabled={saveLoading}
					>
						{saveLoading ? "Saving..." : "Save"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};
