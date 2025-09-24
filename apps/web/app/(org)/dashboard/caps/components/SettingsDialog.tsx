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
import { faGear } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import clsx from "clsx";
import { useMemo } from "react";
import { useDashboardContext } from "../../Contexts";

interface SettingsDialogProps {
	isOpen: boolean;
	onClose: () => void;
}

export const SettingsDialog = ({ isOpen, onClose }: SettingsDialogProps) => {
	const { user } = useDashboardContext();

	const options = useMemo(
		() => [
			{
				label: "Disable comments",
				value: "disable_comments",
				description: "Prevent viewers from commenting on this cap",
			},
			{
				label: "Disable reactions",
				value: "disable_reactions",
				description: "Prevent viewers from reacting to this cap",
			},
			{
				label: "Disable summary",
				value: "disable_summary",
				description: "Remove the summary for this cap",
				pro: true,
			},
			{
				label: "Disable chapters",
				value: "remove_chapters",
				description: "Remove the chapters for this cap",
				pro: true,
			},
			{
				label: "Disable transcript",
				value: "remove_transcript",
				description: "Remove the transcript for this cap",
				pro: true,
			},
		],
		[],
	);

	const isUserPro = userIsPro(user);

	return (
		<Dialog open={isOpen} onOpenChange={onClose}>
			<DialogContent className="max-w-md min-w-fit">
				<DialogHeader
					description="Manage the settings for this cap"
					icon={<FontAwesomeIcon icon={faGear} className="size-3.5" />}
				>
					<DialogTitle>Settings</DialogTitle>
				</DialogHeader>
				<div className="p-5 space-y-3">
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
							<Switch disabled={option.pro && !isUserPro} />
						</div>
					))}
				</div>
				<DialogFooter className="p-5 border-t border-gray-4">
					<Button variant="gray" size="sm" onClick={onClose}>
						Cancel
					</Button>
					<Button variant="dark" size="sm" onClick={onClose}>
						Save
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};
