import { Either, ParseResult, Schema } from "effect";
import {
	APP_CATEGORIES,
	APP_LICENSES,
	APP_STORE_API_VERSIONS,
	BUILTIN_APPS,
	CAP_EVENTS,
	CONNECTION_PERMISSIONS,
	LIMITS,
} from "./constants";

const boundedString = (min: number, max: number) =>
	Schema.String.pipe(
		Schema.minLength(min),
		Schema.maxLength(max),
		Schema.filter((value) => value.trim() === value, {
			message: () => "must not start or end with whitespace",
			jsonSchema: {},
		}),
	);

export const AppId = Schema.String.pipe(
	Schema.minLength(LIMITS.idMinLength),
	Schema.maxLength(LIMITS.idMaxLength),
	Schema.pattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
		message: () => "must be lowercase kebab-case, like my-app",
	}),
).annotations({
	description: "Unique kebab-case id. Must match the folder name.",
});

export const ItemId = Schema.String.pipe(
	Schema.minLength(1),
	Schema.maxLength(LIMITS.itemIdMaxLength),
	Schema.pattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
		message: () => "must be lowercase kebab-case",
	}),
);

export const Semver = Schema.String.pipe(
	Schema.pattern(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, {
		message: () => "must be a version like 1.2.3",
	}),
);

export const HexColor = Schema.String.pipe(
	Schema.pattern(/^#[0-9A-Fa-f]{6}$/, {
		message: () => "must be a hex colour like #1E90FF",
	}),
);

export const HttpsUrl = Schema.String.pipe(
	Schema.maxLength(LIMITS.urlMaxLength),
	Schema.pattern(/^https:\/\/[^\s]+$/, {
		message: () => "must be an https:// URL",
	}),
);

export const ImagePath = Schema.String.pipe(
	Schema.pattern(
		/^(?:[a-z0-9][a-z0-9_-]*\/)*[a-z0-9][a-z0-9_-]*\.(?:png|jpg|jpeg|webp)$/,
		{
			message: () =>
				"must be a lowercase relative path to a .png, .jpg or .webp file inside the app folder",
		},
	),
);

const unit = (min: number, max: number) =>
	Schema.Number.pipe(Schema.between(min, max));

const ItemName = boundedString(1, LIMITS.itemNameMaxLength);
const ItemDescription = boundedString(1, LIMITS.itemDescriptionMaxLength);

export const ImageBackground = Schema.Struct({
	id: ItemId,
	name: ItemName,
	image: ImagePath,
});

export const GradientBackground = Schema.Struct({
	id: ItemId,
	name: ItemName,
	gradient: Schema.Struct({
		from: HexColor,
		to: HexColor,
		angle: Schema.Int.pipe(Schema.between(0, 359)),
	}),
});

export const ColorBackground = Schema.Struct({
	id: ItemId,
	name: ItemName,
	color: HexColor,
});

export const Background = Schema.Union(
	ImageBackground,
	GradientBackground,
	ColorBackground,
);
export type Background = typeof Background.Type;

export const CaptionStyle = Schema.Struct({
	id: ItemId,
	name: ItemName,
	description: Schema.optional(ItemDescription),
	fontWeight: Schema.Literal(400, 500, 700),
	size: Schema.Int.pipe(
		Schema.between(LIMITS.captionSizeMin, LIMITS.captionSizeMax),
	),
	color: HexColor,
	backgroundColor: HexColor,
	backgroundOpacity: Schema.Int.pipe(Schema.between(0, 100)),
	outline: Schema.Boolean,
	outlineColor: HexColor,
	highlightColor: HexColor,
	activeWordHighlight: Schema.Boolean,
	highlightStyle: Schema.Literal("color", "pill"),
	animation: Schema.Literal("none", "bounce", "pop"),
	uppercase: Schema.Boolean,
	fadeDuration: unit(0, 1),
});
export type CaptionStyle = typeof CaptionStyle.Type;

export const ColorLook = Schema.Struct({
	id: ItemId,
	name: ItemName,
	description: Schema.optional(ItemDescription),
	values: Schema.Struct({
		intensity: Schema.optional(unit(0, 1)),
		exposure: Schema.optional(unit(-1, 1)),
		contrast: Schema.optional(unit(-1, 1)),
		saturation: Schema.optional(unit(-1, 1)),
		temperature: Schema.optional(unit(-1, 1)),
		tint: Schema.optional(unit(-1, 1)),
		fade: Schema.optional(unit(0, 1)),
		splitTone: Schema.optional(unit(-1, 1)),
		vignette: Schema.optional(unit(0, 1)),
		grain: Schema.optional(unit(0, 1)),
	}),
});
export type ColorLook = typeof ColorLook.Type;

const SettingKey = Schema.String.pipe(
	Schema.pattern(/^[a-z][a-zA-Z0-9]{0,39}$/, {
		message: () => "must be camelCase, like webhookUrl",
	}),
);

const settingBase = {
	key: SettingKey,
	label: boundedString(1, LIMITS.settingLabelMaxLength),
	description: Schema.optional(
		boundedString(1, LIMITS.settingDescriptionMaxLength),
	),
	required: Schema.optional(Schema.Boolean),
};

const Placeholder = boundedString(1, 80);
const DefaultText = Schema.String.pipe(
	Schema.maxLength(LIMITS.settingDefaultMaxLength),
);

export const TextSetting = Schema.Struct({
	...settingBase,
	type: Schema.Literal("text"),
	placeholder: Schema.optional(Placeholder),
	default: Schema.optional(DefaultText),
});

export const UrlSetting = Schema.Struct({
	...settingBase,
	type: Schema.Literal("url"),
	placeholder: Schema.optional(Placeholder),
	default: Schema.optional(HttpsUrl),
});

export const SecretSetting = Schema.Struct({
	...settingBase,
	type: Schema.Literal("secret"),
	placeholder: Schema.optional(Placeholder),
});

export const SelectSetting = Schema.Struct({
	...settingBase,
	type: Schema.Literal("select"),
	options: Schema.Array(
		Schema.Struct({
			value: boundedString(1, 64),
			label: boundedString(1, LIMITS.settingLabelMaxLength),
		}),
	).pipe(Schema.minItems(1), Schema.maxItems(LIMITS.settingOptionsMax)),
	default: Schema.optional(boundedString(1, 64)),
});

export const ToggleSetting = Schema.Struct({
	key: SettingKey,
	label: boundedString(1, LIMITS.settingLabelMaxLength),
	description: Schema.optional(
		boundedString(1, LIMITS.settingDescriptionMaxLength),
	),
	type: Schema.Literal("toggle"),
	default: Schema.optional(Schema.Boolean),
});

export const SettingField = Schema.Union(
	TextSetting,
	UrlSetting,
	SecretSetting,
	SelectSetting,
	ToggleSetting,
);
export type SettingField = typeof SettingField.Type;

export const ConnectionAction = Schema.Struct({
	id: ItemId,
	title: boundedString(2, LIMITS.actionTitleMaxLength),
	target: Schema.Literal("cap"),
});
export type ConnectionAction = typeof ConnectionAction.Type;

export const ConnectionPermission = Schema.Literal(...CONNECTION_PERMISSIONS);
export const CapEvent = Schema.Literal(...CAP_EVENTS);

export const FIRST_PARTY_CONNECTION_PREFIX = "/api/app-store/first-party/";

export const ConnectionUrl = Schema.String.pipe(
	Schema.maxLength(LIMITS.urlMaxLength),
	Schema.pattern(
		/^(?:https:\/\/[^\s]+|\/api\/app-store\/first-party\/[a-z0-9-]+)$/,
		{
			message: () => "must be an https:// URL",
		},
	),
).annotations({
	description:
		"Base URL of your server. Cap sends signed requests to {url}/lifecycle, {url}/events and {url}/actions/{actionId}.",
});

export const isFirstPartyConnectionUrl = (url: string) =>
	url.startsWith(FIRST_PARTY_CONNECTION_PREFIX);

export const Connection = Schema.Struct({
	url: ConnectionUrl,
	permissions: Schema.optional(Schema.Array(ConnectionPermission)),
	events: Schema.optional(Schema.Array(CapEvent)),
	settings: Schema.optional(
		Schema.Array(SettingField).pipe(Schema.maxItems(LIMITS.settingsMax)),
	),
	actions: Schema.optional(
		Schema.Array(ConnectionAction).pipe(Schema.maxItems(LIMITS.actionsMax)),
	),
});
export type Connection = typeof Connection.Type;

export const Author = Schema.Struct({
	name: boundedString(1, 60),
	github: Schema.String.pipe(
		Schema.pattern(/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/, {
			message: () => "must be a GitHub username or organization",
		}),
	),
	url: Schema.optional(HttpsUrl),
});

export const Manifest = Schema.Struct({
	$schema: Schema.optional(Schema.String),
	apiVersion: Schema.Literal(...APP_STORE_API_VERSIONS).annotations({
		description: "The App Store API version this app is written for.",
	}),
	id: AppId,
	name: boundedString(LIMITS.nameMinLength, LIMITS.nameMaxLength).annotations({
		description: "Shown in the store. Title Case, 2 to 30 characters.",
	}),
	version: Semver.annotations({
		description:
			"Semver like 1.2.3. Raise it whenever anything in the app folder changes.",
	}),
	description: boundedString(
		LIMITS.descriptionMinLength,
		LIMITS.descriptionMaxLength,
	).annotations({
		description: "One sentence, 10 to 140 characters, ending with a full stop.",
	}),
	author: Author,
	license: Schema.Literal(...APP_LICENSES).annotations({
		description: "The license your app is published under.",
	}),
	categories: Schema.Array(Schema.Literal(...APP_CATEGORIES)).pipe(
		Schema.minItems(1),
		Schema.maxItems(LIMITS.categoriesMax),
	),
	keywords: Schema.optional(
		Schema.Array(boundedString(2, LIMITS.keywordMaxLength)).pipe(
			Schema.maxItems(LIMITS.keywordsMax),
		),
	),
	homepage: Schema.optional(HttpsUrl),
	support: Schema.optional(HttpsUrl),
	privacyPolicy: Schema.optional(
		HttpsUrl.annotations({
			description:
				"Required for apps with a connection, because Cap sends them data.",
		}),
	),
	screenshots: Schema.optional(
		Schema.Array(ImagePath).pipe(Schema.maxItems(LIMITS.screenshotsMax)),
	),
	builtin: Schema.optional(
		Schema.Literal(...BUILTIN_APPS).annotations({
			description:
				"Only for apps published by Cap that use one of Cap's own integrations.",
		}),
	),
	backgrounds: Schema.optional(
		Schema.Array(Background).pipe(
			Schema.minItems(1),
			Schema.maxItems(LIMITS.backgroundsMax),
		),
	),
	captionStyles: Schema.optional(
		Schema.Array(CaptionStyle).pipe(
			Schema.minItems(1),
			Schema.maxItems(LIMITS.captionStylesMax),
		),
	),
	colorLooks: Schema.optional(
		Schema.Array(ColorLook).pipe(
			Schema.minItems(1),
			Schema.maxItems(LIMITS.colorLooksMax),
		),
	),
	connection: Schema.optional(Connection),
}).annotations({
	identifier: "CapAppManifest",
	title: "Cap App manifest",
	description:
		"Describes a Cap App. See https://github.com/CapSoftware/Cap/tree/main/app-store",
});
export type Manifest = typeof Manifest.Type;

export type ManifestIssue = { path: string; message: string };

const formatPath = (path: ReadonlyArray<PropertyKey>) =>
	path.length === 0
		? "manifest"
		: path
				.map((segment, index) =>
					typeof segment === "number"
						? `[${segment}]`
						: index === 0
							? String(segment)
							: `.${String(segment)}`,
				)
				.join("");

const decodeManifest = Schema.decodeUnknownEither(Manifest, {
	errors: "all",
	onExcessProperty: "error",
});

export function parseManifest(
	input: unknown,
): { ok: true; manifest: Manifest } | { ok: false; issues: ManifestIssue[] } {
	const result = decodeManifest(input);
	if (Either.isRight(result)) return { ok: true, manifest: result.right };
	const issues = ParseResult.ArrayFormatter.formatErrorSync(result.left).map(
		(issue) => ({ path: formatPath(issue.path), message: issue.message }),
	);
	return { ok: false, issues };
}

export const isImageBackground = (
	background: Background,
): background is typeof ImageBackground.Type => "image" in background;
export const isGradientBackground = (
	background: Background,
): background is typeof GradientBackground.Type => "gradient" in background;
