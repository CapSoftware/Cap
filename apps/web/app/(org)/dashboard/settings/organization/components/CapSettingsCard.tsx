"use client";

import { Card, CardDescription, CardHeader, CardTitle, Switch } from "@cap/ui";
import { userIsPro } from "@cap/utils";
import { useDebounce } from "@uidotdev/usehooks";
import clsx from "clsx";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { updateOrganizationSettings } from "@/actions/organization/settings";
import { useDashboardContext } from "../../../Contexts";
import type { OrganizationSettings } from "../../../dashboard-data";

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

const CapSettingsCard = () => {
	const { user, organizationSettings } = useDashboardContext();
	const [settings, setSettings] = useState<OrganizationSettings>(
		organizationSettings || {
			disableComments: false,
			disableSummary: false,
			disableCaptions: false,
			disableChapters: false,
			disableReactions: false,
			disableTranscript: false,
		},
	);

	const isUserPro = userIsPro(user);

	const debouncedUpdateSettings = useDebounce(settings, 1000);

	const updateSettings = useCallback((newSettings: OrganizationSettings) => {
		if (!newSettings) return;
		try {
			setSettings(newSettings);
			updateOrganizationSettings(newSettings);
		} catch (error) {
			console.error("Error updating organization settings:", error);
			toast.error("Failed to update settings");
			// Revert the local state on error
			setSettings(organizationSettings);
		}
	}, []);

	useEffect(() => {
		if (debouncedUpdateSettings !== organizationSettings) {
			try {
				updateSettings(debouncedUpdateSettings);
			} catch (error) {
				console.error("Error updating organization settings:", error);
				toast.error("Failed to update settings");
				setSettings(organizationSettings);
			}
		}
	}, [debouncedUpdateSettings, organizationSettings, updateSettings]);

	const handleToggle = (key: keyof OrganizationSettings) => {
		setSettings((prev) => ({
			...prev,
			[key]: !prev?.[key],
		}));
	};

	return (
		<Card className="flex relative flex-col flex-1 gap-6 w-full min-h-fit">
			<CardHeader>
				<CardTitle>Cap Settings</CardTitle>
				<CardDescription>
					Enable or disable specific settings for your organization. These
					settings will be applied as defaults for new caps.
				</CardDescription>
			</CardHeader>

			<div className="grid grid-cols-1 gap-3 md:grid-cols-2">
				{options.map((option) => (
					<div
						key={option.value}
						className="flex gap-10 justify-between items-center p-4 text-left rounded-xl border transition-colors min-w-fit border-gray-3 bg-gray-1"
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
							onCheckedChange={() => {
								handleToggle(option.value as keyof OrganizationSettings);
							}}
							checked={settings?.[option.value as keyof typeof settings]}
						/>
					</div>
				))}
			</div>
		</Card>
	);
};

export default CapSettingsCard;
