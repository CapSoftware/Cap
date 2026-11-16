"use client";

import { Switch } from "@cap/ui";
import {
	AI_GENERATION_LANGUAGE_AUTO,
	AI_GENERATION_LANGUAGES,
	type AiGenerationLanguage,
	getAiGenerationLanguageName,
	isAiGenerationLanguage,
	type Organisation,
} from "@cap/web-domain";
import { useDebounce } from "@uidotdev/usehooks";
import clsx from "clsx";
import { Check, ChevronDown, Gauge, Globe } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { updateOrganizationSettings } from "@/actions/organization/settings";
import { DEFAULT_PLAYBACK_SPEED, PLAYBACK_SPEEDS } from "@/lib/playback-speed";
import { useDashboardContext } from "../../../Contexts";
import type { OrganizationSettings } from "../../../dashboard-data";
import {
	ProChip,
	SettingsCard,
	SettingsRow,
	SettingsSection,
} from "../_components/settings-ui";

const defaultSettings: OrganizationSettings = {
	disableComments: false,
	disableSummary: false,
	disableCaptions: false,
	disableChapters: false,
	disableReactions: false,
	disableTranscript: false,
	disableDownloads: false,
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
	{
		label: "Enable downloads",
		value: "disableDownloads",
		description: "Allow viewers to download caps",
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
	const { activeOrganization } = useDashboardContext();
	const organizationId = activeOrganization?.organization.id;
	if (!organizationId) return null;
	return (
		<OrganizationCapSettings
			key={organizationId}
			organizationId={organizationId}
		/>
	);
};

const OrganizationCapSettings = ({
	organizationId,
}: {
	organizationId: Organisation.OrganisationId;
}) => {
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
					await updateOrganizationSettings(
						debouncedUpdateSettings,
						organizationId,
					);

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
	}, [debouncedUpdateSettings, organizationSettings, organizationId]);

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
		<div className="flex flex-col gap-10">
			<SettingsSection title="Defaults for new caps">
				<SettingsCard>
					{options.map((option) => (
						<SettingsRow
							key={option.value}
							title={option.label}
							meta={option.pro ? <ProChip /> : null}
							description={option.description}
							control={
								<Switch
									aria-label={option.label}
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
							}
						/>
					))}
				</SettingsCard>
			</SettingsSection>

			<SettingsSection title="Playback and AI">
				<SettingsCard>
					<SettingsRow
						title={
							<span className="flex gap-1.5 items-center">
								<Gauge className="size-3.5 text-gray-9" />
								Default playback speed
							</span>
						}
						description="The speed caps start playing at on shareable links. Viewers can still change it."
						control={
							<div className="flex flex-wrap gap-0.5 items-center p-0.5 rounded-lg bg-gray-3">
								{PLAYBACK_SPEEDS.map((speed) => (
									<button
										key={speed}
										type="button"
										onClick={() => handleSpeedChange(speed)}
										aria-pressed={selectedSpeed === speed}
										className={clsx(
											"px-2 h-7 text-xs font-medium tabular-nums rounded-md transition-colors min-w-9",
											selectedSpeed === speed
												? "bg-gray-1 text-gray-12 shadow-[0_1px_2px_rgba(0,0,0,0.08)]"
												: "text-gray-10 hover:text-gray-12",
										)}
									>
										{speed}×
									</button>
								))}
							</div>
						}
					/>
					<SettingsRow
						title="AI generation language"
						meta={<ProChip />}
						description="Set the language used for transcripts, titles, summaries, and chapters."
						control={
							<div className="relative" ref={languageMenuRef}>
								<button
									onClick={() => setShowLanguageMenu((value) => !value)}
									disabled={!user.isPro}
									aria-expanded={showLanguageMenu}
									className="flex gap-1.5 items-center px-3 h-8 text-[13px] font-medium rounded-full border shadow-xs transition-colors border-gray-4 bg-gray-1 text-gray-12 hover:bg-gray-2 disabled:opacity-50 disabled:cursor-not-allowed"
									type="button"
								>
									<Globe className="size-3.5 text-gray-9" />
									{getAiGenerationLanguageName(selectedLanguage)}
									<ChevronDown className="size-3.5 text-gray-9" />
								</button>
								{showLanguageMenu && (
									<div className="overflow-y-auto absolute right-0 top-full z-50 p-1 mt-1.5 w-56 max-h-64 rounded-xl border shadow-lg bg-gray-1 border-gray-3">
										{languageOptions.map(([code, name], index) => (
											<div key={code}>
												{index === 1 && (
													<div className="my-1 border-t border-gray-3" />
												)}
												<button
													onClick={() => handleLanguageChange(code)}
													className={clsx(
														"flex justify-between items-center px-2.5 w-full h-8 text-[13px] text-left rounded-lg transition-colors text-gray-12",
														selectedLanguage === code
															? "bg-gray-3"
															: "hover:bg-gray-2",
													)}
													type="button"
												>
													{name}
													{selectedLanguage === code && (
														<Check className="size-3.5 text-gray-12" />
													)}
												</button>
											</div>
										))}
									</div>
								)}
							</div>
						}
					/>
				</SettingsCard>
			</SettingsSection>
		</div>
	);
};

export default CapSettingsCard;
