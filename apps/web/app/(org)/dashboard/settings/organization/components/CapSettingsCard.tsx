"use client";

import { Card, CardDescription, CardHeader, CardTitle, Switch } from "@cap/ui";
import { userIsPro } from "@cap/utils";
import { useDebounce } from "@uidotdev/usehooks";
import clsx from "clsx";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { updateOrganizationSettings } from "@/actions/organization/settings";
import { useDashboardContext } from "../../../Contexts";
import type { OrganizationSettings } from "../../../dashboard-data";

const options = [
	{
		label: "Enable comments",
		value: "disableComments",
		description: "Allow viewers to comment on caps",
	},
	{
		label: "Enable summary",
		value: "disableSummary",
		description: "Show AI-generated summary (requires transcript)",
		pro: true,
	},
	{
		label: "Enable captions",
		value: "disableCaptions",
		description: "Allow viewers to use captions for caps",
	},
	{
		label: "Enable chapters",
		value: "disableChapters",
		description: "Show AI-generated chapters (requires transcript)",
		pro: true,
	},
	{
		label: "Enable reactions",
		value: "disableReactions",
		description: "Allow viewers to react to caps",
	},
	{
		label: "Enable transcript",
		value: "disableTranscript",
		description: "Enabling this also allows generating chapters and summary",
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

	const lastSavedSettings = useRef<OrganizationSettings>(
		organizationSettings || settings,
	);

	const isUserPro = userIsPro(user);

	const debouncedUpdateSettings = useDebounce(settings, 1000);

	useEffect(() => {
		const next = organizationSettings ?? {
			disableComments: false,
			disableSummary: false,
			disableCaptions: false,
			disableChapters: false,
			disableReactions: false,
			disableTranscript: false,
		};
		setSettings(next);
		lastSavedSettings.current = next;
	}, [organizationSettings]);

	useEffect(() => {
		if (
			debouncedUpdateSettings &&
			debouncedUpdateSettings !== lastSavedSettings.current
		) {
			const handleUpdate = async () => {
				const changedKeys: Array<keyof OrganizationSettings> = [];
				for (const key of Object.keys(debouncedUpdateSettings) as Array<
					keyof OrganizationSettings
				>) {
					if (
						debouncedUpdateSettings[key] !== lastSavedSettings.current?.[key]
					) {
						changedKeys.push(key);
					}
				}

				if (changedKeys.length === 0) {
					return;
				}

				try {
					await updateOrganizationSettings(debouncedUpdateSettings);

					changedKeys.forEach((changedKey) => {
						const option = options.find((opt) => opt.value === changedKey);
						const isDisabled = debouncedUpdateSettings[changedKey];
						const action = isDisabled ? "disabled" : "enabled";
						const label =
							option?.label.replace(/^Disable /, "").toLowerCase() ||
							changedKey;
						toast.success(
							`${label.charAt(0).toUpperCase()}${label.slice(1)} ${action}`,
						);
					});

					lastSavedSettings.current = debouncedUpdateSettings;
				} catch (error) {
					console.error("Error updating organization settings:", error);
					toast.error("Failed to update settings");
					if (organizationSettings) {
						setSettings(organizationSettings);
					}
				}
			};

			handleUpdate();
		}
	}, [debouncedUpdateSettings, organizationSettings]);

	const handleToggle = (key: keyof OrganizationSettings) => {
		setSettings((prev) => {
			const newValue = !prev?.[key];

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
							disabled={
								(option.pro && !isUserPro) ||
								((option.value === "disableSummary" ||
									option.value === "disableChapters") &&
									settings?.disableTranscript)
							}
							onCheckedChange={() => {
								handleToggle(option.value as keyof OrganizationSettings);
							}}
							checked={!settings?.[option.value as keyof typeof settings]}
						/>
					</div>
				))}
			</div>
		</Card>
	);
};

export default CapSettingsCard;
