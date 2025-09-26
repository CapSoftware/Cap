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
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { updateVideoSettings } from "@/actions/videos/settings";
import { useDashboardContext } from "../../Contexts";

interface SettingsDialogProps {
	isOpen: boolean;
	onClose: () => void;
	capId: Video.VideoId;
	settingsData?: {
		disableComments?: boolean;
		disableSummary?: boolean;
		disableCaptions?: boolean;
		disableChapters?: boolean;
		disableReactions?: boolean;
		disableTranscript?: boolean;
	};
}

const options = [
	{
		label: "Disable comments",
		value: "disableComments",
		description: "Prevent viewers from commenting on this cap",
	},
	{
		label: "Disable summary",
		value: "disableSummary",
		description: "Remove the summary for this cap",
		pro: true,
	},
	{
		label: "Disable captions",
		value: "disableCaptions",
		description: "Prevent viewers from using captions for this cap",
	},
	{
		label: "Disable chapters",
		value: "disableChapters",
		description: "Remove the chapters for this cap",
		pro: true,
	},
	{
		label: "Disable reactions",
		value: "disableReactions",
		description: "Prevent viewers from reacting to this cap",
	},
	{
		label: "Disable transcript",
		value: "disableTranscript",
		description: "Remove the transcript for this cap",
		pro: true,
	},
];

export const SettingsDialog = ({
	isOpen,
	onClose,
	capId,
	settingsData,
}: SettingsDialogProps) => {
	const { user } = useDashboardContext();
	const [saveLoading, setSaveLoading] = useState(false);
	const [settings, setSettings] = useState<typeof settingsData>({
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
					{options.map((option) => (
						<div
							key={option.value}
							className="flex gap-10 justify-between items-center p-4 rounded-xl border min-w-fit border-gray-3 bg-gray-1"
						>
							<div
								className={clsx("flex flex-col flex-1", option.pro && "gap-1")}
							>
								<div className="flex gap-1.5 items-center">
									<p className="text-sm text-gray-12">{option.label}</p>
									{option.pro && (
										<p className="py-1 px-1.5 text-[10px] leading-none font-medium rounded-full text-gray-12 bg-blue-11">
											Pro
										</p>
									)}
								</div>
								<p className="text-xs text-gray-10">{option.description}</p>
							</div>
							<Switch
								disabled={option.pro && !isUserPro}
								checked={settings?.[option.value as keyof typeof settings]}
								onCheckedChange={(checked) =>
									setSettings({
										...settings,
										[option.value as keyof typeof settings]: checked,
									})
								}
							/>
						</div>
					))}
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
