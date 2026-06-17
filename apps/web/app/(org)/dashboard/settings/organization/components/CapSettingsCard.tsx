"use client";

import { Card, CardDescription, CardHeader, CardTitle, Switch } from "@cap/ui";
import {
	AI_GENERATION_LANGUAGE_AUTO,
	AI_GENERATION_LANGUAGES,
	type AiGenerationLanguage,
	getAiGenerationLanguageName,
	isAiGenerationLanguage,
} from "@cap/web-domain";
import { useDebounce } from "@uidotdev/usehooks";
import clsx from "clsx";
import { ChevronDown, Gauge, Globe } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { updateOrganizationSettings } from "@/actions/organization/settings";
import { DEFAULT_PLAYBACK_SPEED, PLAYBACK_SPEEDS } from "@/lib/playback-speed";
import { useDashboardContext } from "../../../Contexts";
import type { OrganizationSettings } from "../../../dashboard-data";

const defaultSettings: OrganizationSettings = {
	disableComments: false,
	disableSummary: false,
	disableCaptions: false,
	disableChapters: false,
	disableReactions: false,
	disableTranscript: false,
	hideShareableLinkCapLogo: false,
	shareableLinkUseOrganizationIcon: false,
	aiGenerationLanguage: AI_GENERATION_LANGUAGE_AUTO,
	defaultPlaybackSpeed: DEFAULT_PLAYBACK_SPEED,
};

type BooleanOrganizationSettingKey = Exclude<
	keyof OrganizationSettings,
	"aiGenerationLanguage"
>;

const options: Array<{
	label: string;
	value: BooleanOrganizationSettingKey;
	description: string;
	pro?: boolean;
}> = [
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
		description: "Enabling this also allows chapters and summary",
		pro: true,
	},
	{
		label: "Show Cap logo",
		value: "hideShareableLinkCapLogo",
		description: "Show Cap branding at the top of shareable links",
		pro: true,
	},
];

const languageOptions = Object.entries(AI_GENERATION_LANGUAGES) as [
	AiGenerationLanguage,
	string,
][];

const mergeSettings = (
	settings?: OrganizationSettings | null,
): OrganizationSettings => ({
	...defaultSettings,
	...(settings ?? {}),
	aiGenerationLanguage: isAiGenerationLanguage(settings?.aiGenerationLanguage)
		? settings.aiGenerationLanguage
		: AI_GENERATION_LANGUAGE_AUTO,
});

const CapSettingsCard = () => {
	const { user, organizationSettings } = useDashboardContext();
	const initialSettings = mergeSettings(organizationSettings);
	const [settings, setSettings] =
		useState<OrganizationSettings>(initialSettings);
	const [showLanguageMenu, setShowLanguageMenu] = useState(false);

	const lastSavedSettings = useRef<OrganizationSettings>(initialSettings);
	const languageMenuRef = useRef<HTMLDivElement>(null);

	const debouncedUpdateSettings = useDebounce(settings, 1000);
	const selectedLanguage =
		settings.aiGenerationLanguage ?? AI_GENERATION_LANGUAGE_AUTO;

	useEffect(() => {
		const next = mergeSettings(organizationSettings);
		setSettings(next);
		lastSavedSettings.current = next;
	}, [organizationSettings]);

	useEffect(() => {
		const handleClickOutside = (event: MouseEvent) => {
			if (
				languageMenuRef.current &&
				!languageMenuRef.current.contains(event.target as Node)
			) {
				setShowLanguageMenu(false);
			}
		};

		document.addEventListener("mousedown", handleClickOutside);
		return () => document.removeEventListener("mousedown", handleClickOutside);
	}, []);

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
						if (changedKey === "aiGenerationLanguage") {
							const language =
								debouncedUpdateSettings.aiGenerationLanguage ??
								AI_GENERATION_LANGUAGE_AUTO;
							toast.success(
								`AI language set to ${getAiGenerationLanguageName(language)}`,
							);
							return;
						}

						if (changedKey === "defaultPlaybackSpeed") {
							toast.success(
								`Default playback speed set to ${
									debouncedUpdateSettings.defaultPlaybackSpeed ??
									DEFAULT_PLAYBACK_SPEED
								}×`,
							);
							return;
						}

						const option = options.find((opt) => opt.value === changedKey);
						if (changedKey === "hideShareableLinkCapLogo") {
							toast.success(
								debouncedUpdateSettings[changedKey]
									? "Cap logo hidden"
									: "Cap logo shown",
							);
						} else {
							const isDisabled = Boolean(debouncedUpdateSettings[changedKey]);
							const action = isDisabled ? "disabled" : "enabled";
							const label = option?.label.split(" ")[1] || changedKey;
							toast.success(
								`${label.charAt(0).toUpperCase()}${label.slice(1)} ${action}`,
							);
						}
					});

					lastSavedSettings.current = debouncedUpdateSettings;
				} catch (error) {
					console.error("Error updating organization settings:", error);
					toast.error("Failed to update settings");
					setSettings(mergeSettings(organizationSettings));
				}
			};

			handleUpdate();
		}
	}, [debouncedUpdateSettings, organizationSettings]);

	const handleToggle = (key: BooleanOrganizationSettingKey) => {
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

	const handleSpeedChange = (speed: number) => {
		setSettings((prev) => ({
			...prev,
			defaultPlaybackSpeed: speed,
		}));
	};

	const selectedSpeed = settings.defaultPlaybackSpeed ?? DEFAULT_PLAYBACK_SPEED;

	const handleLanguageChange = (language: AiGenerationLanguage) => {
		if (!isAiGenerationLanguage(language)) {
			return;
		}

		setShowLanguageMenu(false);
		setSettings((prev) => ({
			...prev,
			aiGenerationLanguage: language,
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
						className="flex gap-10 justify-between items-center p-4 text-left rounded-xl border transition-colors bg-gray-2 min-w-fit border-gray-3"
					>
						<div
							className={clsx("flex flex-col flex-1", option.pro && "gap-1")}
						>
							<div className="flex gap-1.5 items-center">
								<p className="text-sm text-gray-12">{option.label}</p>
								{option.pro && (
									<p className="py-1 px-1.5 text-[10px] leading-none font-medium rounded-full text-white bg-blue-11">
										Pro
									</p>
								)}
							</div>
							<p className="text-xs text-gray-10">{option.description}</p>
						</div>
						<Switch
							disabled={
								(option.pro && !user.isPro) ||
								((option.value === "disableSummary" ||
									option.value === "disableChapters") &&
									settings?.disableTranscript)
							}
							onCheckedChange={() => {
								handleToggle(option.value);
							}}
							checked={!settings?.[option.value]}
						/>
					</div>
				))}
			</div>

			<div className="flex flex-col gap-3 p-4 text-left rounded-xl border transition-colors bg-gray-2 border-gray-3 sm:flex-row sm:justify-between sm:items-center">
				<div className="flex flex-col flex-1 gap-1">
					<div className="flex gap-1.5 items-center">
						<Gauge className="w-3.5 h-3.5 text-gray-9" />
						<p className="text-sm text-gray-12">Default playback speed</p>
					</div>
					<p className="text-xs text-gray-10">
						The speed caps start playing at on shareable links. Viewers can
						still change it.
					</p>
				</div>
				<div className="flex flex-wrap gap-1 items-center p-1 rounded-lg border bg-gray-1 border-gray-3">
					{PLAYBACK_SPEEDS.map((speed) => (
						<button
							key={speed}
							type="button"
							onClick={() => handleSpeedChange(speed)}
							aria-pressed={selectedSpeed === speed}
							className={clsx(
								"min-w-10 rounded-md px-2 py-1 text-xs font-medium tabular-nums transition-colors",
								selectedSpeed === speed
									? "text-white bg-blue-11"
									: "text-gray-11 hover:bg-gray-3",
							)}
						>
							{speed}×
						</button>
					))}
				</div>
			</div>

			<div className="flex flex-col gap-3 p-4 text-left rounded-xl border transition-colors bg-gray-2 border-gray-3 sm:flex-row sm:justify-between sm:items-center">
				<div className="flex flex-col flex-1 gap-1">
					<div className="flex gap-1.5 items-center">
						<p className="text-sm text-gray-12">AI generation language</p>
						<p className="py-1 px-1.5 text-[10px] leading-none font-medium rounded-full text-white bg-blue-11">
							Pro
						</p>
					</div>
					<p className="text-xs text-gray-10">
						Set the language used for transcripts, titles, summaries, and
						chapters.
					</p>
				</div>
				<div className="relative w-full sm:w-auto" ref={languageMenuRef}>
					<button
						onClick={() => setShowLanguageMenu((value) => !value)}
						disabled={!user.isPro}
						className="flex items-center gap-1.5 px-2.5 py-1.5 w-full justify-between text-xs font-medium rounded-lg border border-gray-3 bg-gray-1 hover:bg-gray-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors sm:min-w-40"
						type="button"
					>
						<span className="flex items-center gap-1.5 text-gray-12">
							<Globe className="w-3 h-3 text-gray-9" />
							{getAiGenerationLanguageName(selectedLanguage)}
						</span>
						<ChevronDown className="w-3 h-3 text-gray-9" />
					</button>
					{showLanguageMenu && (
						<div className="absolute right-0 top-full mt-1 z-50 w-full py-1 bg-gray-1 border border-gray-3 rounded-lg shadow-lg max-h-64 overflow-y-auto sm:w-56">
							{languageOptions.map(([code, name], index) => (
								<div key={code}>
									{index === 1 && (
										<div className="my-1 border-t border-gray-3" />
									)}
									<button
										onClick={() => handleLanguageChange(code)}
										className={`w-full px-3 py-1.5 text-left text-xs hover:bg-gray-2 transition-colors ${
											selectedLanguage === code
												? "text-blue-500 font-medium"
												: "text-gray-12"
										}`}
										type="button"
									>
										{name}
									</button>
								</div>
							))}
						</div>
					)}
				</div>
			</div>
		</Card>
	);
};

export default CapSettingsCard;
