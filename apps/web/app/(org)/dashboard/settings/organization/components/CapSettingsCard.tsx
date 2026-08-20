"use client";

import { Button, Input, Switch } from "@cap/ui";
import {
	AI_GENERATION_LANGUAGE_AUTO,
	AI_GENERATION_LANGUAGES,
	type AiGenerationLanguage,
	getAiGenerationLanguageName,
	isAiGenerationLanguage,
} from "@cap/web-domain";
import { useMutation } from "@tanstack/react-query";
import { useDebounce } from "@uidotdev/usehooks";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
	removeOrganizationDefaultVideoPassword,
	setOrganizationDefaultVideoPassword,
} from "@/actions/organization/default-video-password";
import { updateOrganizationSettings } from "@/actions/organization/settings";
import { DEFAULT_PLAYBACK_SPEED, PLAYBACK_SPEEDS } from "@/lib/playback-speed";
import { useDashboardContext } from "../../../Contexts";
import type { OrganizationSettings } from "../../../dashboard-data";
import { type SelectOption, SettingRow, SettingSelect } from "./SettingsRows";

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
		label: "Comments",
		value: "disableComments",
		description: "Allow viewers to comment",
	},
	{
		label: "Reactions",
		value: "disableReactions",
		description: "Allow viewers to react",
	},
	{
		label: "Transcript",
		value: "disableTranscript",
		description: "Also required for chapters and summary",
		pro: true,
	},
	{
		label: "Chapters",
		value: "disableChapters",
		description: "AI generated, requires transcript",
		pro: true,
	},
	{
		label: "Summary",
		value: "disableSummary",
		description: "AI generated, requires transcript",
		pro: true,
	},
	{
		label: "Captions",
		value: "disableCaptions",
		description: "Let viewers turn on captions",
	},
	{
		label: "Cap logo",
		value: "hideShareableLinkCapLogo",
		description: "Show Cap branding on share pages",
		pro: true,
	},
];

const languageOptions = Object.entries(AI_GENERATION_LANGUAGES) as [
	AiGenerationLanguage,
	string,
][];

const languageSelectOptions: SelectOption<AiGenerationLanguage>[] =
	languageOptions.map(([code], index) => ({
		label: getAiGenerationLanguageName(code),
		value: code,
		separatorBefore: index === 1,
	}));

const visibilityOptions: SelectOption<boolean>[] = [
	{ label: "Anyone with the link", value: true },
	{ label: "Private", value: false },
];

const speedOptions: SelectOption<number>[] = PLAYBACK_SPEEDS.map((speed) => ({
	label: `${speed}x`,
	value: speed,
}));

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
	const {
		user,
		organizationSettings,
		activeOrganization,
		instanceVideoDefaultPublic,
		setUpgradeModalOpen,
	} = useDashboardContext();
	const router = useRouter();
	const initialSettings = mergeSettings(organizationSettings);
	const [settings, setSettings] =
		useState<OrganizationSettings>(initialSettings);
	const hasDefaultVideoPassword = Boolean(
		activeOrganization?.organization.hasDefaultVideoPassword,
	);
	const [defaultPasswordEnabled, setDefaultPasswordEnabled] = useState(
		hasDefaultVideoPassword,
	);
	const [isChangingDefaultPassword, setIsChangingDefaultPassword] =
		useState(false);
	const [defaultPassword, setDefaultPassword] = useState("");

	const lastSavedSettings = useRef<OrganizationSettings>(initialSettings);

	const debouncedUpdateSettings = useDebounce(settings, 1000);
	const selectedLanguage =
		settings.aiGenerationLanguage ?? AI_GENERATION_LANGUAGE_AUTO;

	useEffect(() => {
		const next = mergeSettings(organizationSettings);
		setSettings(next);
		lastSavedSettings.current = next;
	}, [organizationSettings]);

	useEffect(() => {
		setDefaultPasswordEnabled(hasDefaultVideoPassword);
		setIsChangingDefaultPassword(false);
		setDefaultPassword("");
	}, [hasDefaultVideoPassword]);

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

						if (changedKey === "defaultVideoPublic") {
							toast.success(
								debouncedUpdateSettings.defaultVideoPublic === false
									? "New caps will be private"
									: "New caps will be shared with anyone with the link",
							);
							return;
						}

						if (changedKey === "defaultPlaybackSpeed") {
							toast.success(
								`Default playback speed set to ${
									debouncedUpdateSettings.defaultPlaybackSpeed ??
									DEFAULT_PLAYBACK_SPEED
								}x`,
							);
							return;
						}

						if (changedKey === "hideShareableLinkCapLogo") {
							toast.success(
								debouncedUpdateSettings[changedKey]
									? "Cap logo hidden"
									: "Cap logo shown",
							);
							return;
						}

						const option = options.find((opt) => opt.value === changedKey);
						const action = debouncedUpdateSettings[changedKey]
							? "disabled"
							: "enabled";
						toast.success(`${option?.label ?? changedKey} ${action}`);
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

	const handleVisibilityChange = (isPublic: boolean) => {
		setSettings((prev) => ({
			...prev,
			defaultVideoPublic: isPublic,
		}));
	};

	const defaultVideoPublic =
		settings.defaultVideoPublic ?? instanceVideoDefaultPublic;

	const saveDefaultPassword = useMutation({
		mutationFn: async () => {
			const result = await setOrganizationDefaultVideoPassword(defaultPassword);
			if (!result.success)
				throw new Error(result.error ?? "Failed to update default password");
			return result.value;
		},
		onSuccess: () => {
			toast.success("Default password updated");
			setDefaultPassword("");
			setIsChangingDefaultPassword(false);
			router.refresh();
		},
		onError: (error) => {
			toast.error(error.message);
		},
	});

	const removeDefaultPassword = useMutation({
		mutationFn: async () => {
			const result = await removeOrganizationDefaultVideoPassword();
			if (!result.success)
				throw new Error(result.error ?? "Failed to remove default password");
			return result.value;
		},
		onSuccess: () => {
			toast.success("Default password removed");
			setDefaultPassword("");
			setIsChangingDefaultPassword(false);
			setDefaultPasswordEnabled(false);
			router.refresh();
		},
		onError: (error) => {
			toast.error(error.message);
			setDefaultPasswordEnabled(hasDefaultVideoPassword);
		},
	});

	const defaultPasswordPending =
		saveDefaultPassword.isPending || removeDefaultPassword.isPending;

	const handleDefaultPasswordToggle = (checked: boolean) => {
		if (checked) {
			setDefaultPasswordEnabled(true);
			return;
		}

		if (hasDefaultVideoPassword) {
			removeDefaultPassword.mutate();
			return;
		}

		setDefaultPasswordEnabled(false);
		setIsChangingDefaultPassword(false);
		setDefaultPassword("");
	};

	const handleLanguageChange = (language: AiGenerationLanguage) => {
		if (!isAiGenerationLanguage(language)) {
			return;
		}

		setSettings((prev) => ({
			...prev,
			aiGenerationLanguage: language,
		}));
	};

	const requireProInterceptor = user.isPro
		? undefined
		: () => setUpgradeModalOpen(true);

	return (
		<div className="flex flex-col w-full max-w-2xl">
			<section>
				<h2 className="text-sm font-medium text-gray-12">Sharing</h2>
				<div className="mt-3 rounded-xl border divide-y shadow-xs border-gray-3 divide-gray-3 bg-gray-1">
					<SettingRow
						label="Who can view new caps"
						description="Anyone with the link, or private until the creator shares it."
						control={
							<SettingSelect
								ariaLabel="Who can view new caps"
								value={defaultVideoPublic}
								options={visibilityOptions}
								onChange={handleVisibilityChange}
							/>
						}
					/>
					<div>
						<SettingRow
							label="Password protect new caps"
							description="New caps get this password automatically. Viewers need it to open the link."
							control={
								<Switch
									aria-label="Password protect new caps"
									checked={defaultPasswordEnabled}
									disabled={defaultPasswordPending}
									onCheckedChange={handleDefaultPasswordToggle}
								/>
							}
						/>
						{defaultPasswordEnabled &&
							(hasDefaultVideoPassword && !isChangingDefaultPassword ? (
								<div className="flex flex-wrap gap-4 items-center px-4 pb-4">
									<p className="text-[13px] text-gray-10">
										A default password is set.
									</p>
									<div className="flex gap-4 items-center">
										<Button
											size="xs"
											variant="transparent"
											className="px-0 h-auto text-[13px]"
											disabled={defaultPasswordPending}
											onClick={() => setIsChangingDefaultPassword(true)}
										>
											Change
										</Button>
										<Button
											size="xs"
											variant="transparent"
											className="px-0 h-auto text-[13px]"
											disabled={defaultPasswordPending}
											spinner={removeDefaultPassword.isPending}
											spinnerColor="var(--gray-12)"
											onClick={() => removeDefaultPassword.mutate()}
										>
											Remove
										</Button>
									</div>
								</div>
							) : (
								<div className="flex flex-col gap-2 px-4 pb-4 sm:flex-row sm:items-center">
									<Input
										type="password"
										autoComplete="new-password"
										maxLength={255}
										className="sm:max-w-xs"
										placeholder="New default password"
										value={defaultPassword}
										onChange={(e) => setDefaultPassword(e.target.value)}
									/>
									<div className="flex gap-2 items-center">
										<Button
											size="sm"
											variant="dark"
											spinner={saveDefaultPassword.isPending}
											disabled={
												defaultPasswordPending ||
												defaultPassword.trim().length === 0
											}
											onClick={() => saveDefaultPassword.mutate()}
										>
											Save
										</Button>
										{hasDefaultVideoPassword && (
											<Button
												size="sm"
												variant="gray"
												disabled={defaultPasswordPending}
												onClick={() => {
													setIsChangingDefaultPassword(false);
													setDefaultPassword("");
												}}
											>
												Cancel
											</Button>
										)}
									</div>
								</div>
							))}
					</div>
				</div>
			</section>

			<section className="mt-10">
				<h2 className="text-sm font-medium text-gray-12">Playback</h2>
				<div className="mt-3 rounded-xl border divide-y shadow-xs border-gray-3 divide-gray-3 bg-gray-1">
					<SettingRow
						label="Default playback speed"
						description="Starting speed on share pages."
						control={
							<SettingSelect
								ariaLabel="Default playback speed"
								value={selectedSpeed}
								options={speedOptions}
								onChange={handleSpeedChange}
							/>
						}
					/>
					<SettingRow
						label="AI generation language"
						pro
						description="Used for transcripts, titles, summaries, and chapters."
						control={
							<SettingSelect
								ariaLabel="AI generation language"
								value={selectedLanguage}
								options={languageSelectOptions}
								onChange={handleLanguageChange}
								onInterceptOpen={requireProInterceptor}
							/>
						}
					/>
				</div>
			</section>

			<section className="mt-10">
				<h2 className="text-sm font-medium text-gray-12">Share page</h2>
				<div className="mt-3 rounded-xl border divide-y shadow-xs border-gray-3 divide-gray-3 bg-gray-1">
					{options.map((option) => (
						<SettingRow
							key={option.value}
							label={option.label}
							description={option.description}
							pro={option.pro}
							control={
								<Switch
									aria-label={option.label}
									disabled={
										(option.value === "disableSummary" ||
											option.value === "disableChapters") &&
										Boolean(settings?.disableTranscript)
									}
									onCheckedChange={() => {
										if (option.pro && !user.isPro) {
											setUpgradeModalOpen(true);
											return;
										}

										handleToggle(option.value);
									}}
									checked={!settings?.[option.value]}
								/>
							}
						/>
					))}
				</div>
			</section>
		</div>
	);
};

export default CapSettingsCard;
