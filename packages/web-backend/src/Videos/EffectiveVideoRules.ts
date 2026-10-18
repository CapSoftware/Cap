export type ViewerSettingKey =
	| "disableSummary"
	| "disableCaptions"
	| "disableChapters"
	| "disableReactions"
	| "disableTranscript"
	| "disableComments";

export type ViewerSettings = Partial<Record<ViewerSettingKey, boolean>>;

export type SpaceRuleInput = {
	id: string;
	name: string;
	settings?: ViewerSettings | null;
	hasPassword?: boolean;
	password?: string | null;
};

export type SpaceRuleSource = {
	id: string;
	name: string;
};

export type EffectiveVideoRules = {
	settings: Required<ViewerSettings>;
	inheritedSettings: Partial<Record<ViewerSettingKey, SpaceRuleSource[]>>;
	inheritedPasswordSources: SpaceRuleSource[];
	hasInheritedPassword: boolean;
};

const settingKeys: ViewerSettingKey[] = [
	"disableSummary",
	"disableCaptions",
	"disableChapters",
	"disableReactions",
	"disableTranscript",
	"disableComments",
];

const emptySettings: Required<ViewerSettings> = {
	disableSummary: false,
	disableCaptions: false,
	disableChapters: false,
	disableReactions: false,
	disableTranscript: false,
	disableComments: false,
};

export function resolveEffectiveVideoRules({
	videoSettings,
	organizationSettings,
	spaces,
}: {
	videoSettings?: ViewerSettings | null;
	organizationSettings?: ViewerSettings | null;
	spaces: SpaceRuleInput[];
}): EffectiveVideoRules {
	const inheritedSettings: Partial<
		Record<ViewerSettingKey, SpaceRuleSource[]>
	> = {};
	const settings = { ...emptySettings };

	for (const key of settingKeys) {
		const sources = spaces
			.filter((space) => space.settings?.[key] === true)
			.map((space) => ({ id: space.id, name: space.name }));

		if (sources.length > 0) {
			settings[key] = true;
			inheritedSettings[key] = sources;
		} else {
			settings[key] =
				videoSettings?.[key] ?? organizationSettings?.[key] ?? false;
		}
	}

	const inheritedPasswordSources = spaces
		.filter((space) => space.hasPassword || Boolean(space.password))
		.map((space) => ({ id: space.id, name: space.name }));

	return {
		settings,
		inheritedSettings,
		inheritedPasswordSources,
		hasInheritedPassword: inheritedPasswordSources.length > 0,
	};
}

export function collectPasswordHashes({
	videoPassword,
	spacePasswords,
}: {
	videoPassword?: string | null;
	spacePasswords: Array<{ password?: string | null }>;
}) {
	return [
		...(videoPassword ? [videoPassword] : []),
		...spacePasswords
			.map((space) => space.password)
			.filter((password): password is string => Boolean(password)),
	];
}
