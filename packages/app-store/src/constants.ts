export const APP_STORE_API_VERSIONS = [1] as const;
export type AppStoreApiVersion = (typeof APP_STORE_API_VERSIONS)[number];
export const CURRENT_APP_STORE_API_VERSION: AppStoreApiVersion = 1;

export const APP_CATEGORIES = [
	"backgrounds",
	"captions",
	"color",
	"communication",
	"productivity",
	"project-management",
	"documentation",
	"storage",
	"automation",
	"developer-tools",
	"sales",
	"education",
] as const;
export type AppCategory = (typeof APP_CATEGORIES)[number];

export const APP_CATEGORY_LABELS: Record<AppCategory, string> = {
	backgrounds: "Backgrounds",
	captions: "Captions",
	color: "Color",
	communication: "Communication",
	productivity: "Productivity",
	"project-management": "Project management",
	documentation: "Documentation",
	storage: "Storage",
	automation: "Automation",
	"developer-tools": "Developer tools",
	sales: "Sales",
	education: "Education",
};

export const APP_LICENSES = [
	"MIT",
	"Apache-2.0",
	"BSD-2-Clause",
	"BSD-3-Clause",
	"ISC",
	"MPL-2.0",
	"Unlicense",
	"CC0-1.0",
	"CC-BY-4.0",
] as const;
export type AppLicense = (typeof APP_LICENSES)[number];

export const CAP_EVENTS = [
	"cap.ready",
	"cap.transcript.ready",
	"cap.summary.ready",
	"cap.comment.created",
] as const;
export type CapEventType = (typeof CAP_EVENTS)[number];

export const CAP_EVENT_DESCRIPTIONS: Record<CapEventType, string> = {
	"cap.ready": "A new Cap finished uploading",
	"cap.transcript.ready": "A Cap's transcript is ready",
	"cap.summary.ready": "A Cap's AI summary is ready",
	"cap.comment.created": "Someone commented on a Cap",
};

export const CONNECTION_PERMISSIONS = [
	"cap.transcript",
	"cap.summary",
	"cap.comments",
] as const;
export type ConnectionPermission = (typeof CONNECTION_PERMISSIONS)[number];

export const BASE_PERMISSION_DESCRIPTION =
	"Title, share link, owner name, length and creation time of Caps it can see";

export const CONNECTION_PERMISSION_DESCRIPTIONS: Record<
	ConnectionPermission,
	string
> = {
	"cap.transcript": "Transcripts",
	"cap.summary": "AI titles, summaries and chapters",
	"cap.comments": "Comment text and commenter names",
};

export const EVENT_REQUIRED_PERMISSION: Partial<
	Record<CapEventType, ConnectionPermission>
> = {
	"cap.transcript.ready": "cap.transcript",
	"cap.summary.ready": "cap.summary",
	"cap.comment.created": "cap.comments",
};

export const BUILTIN_APPS = ["slack", "amazon-s3", "google-drive"] as const;
export type BuiltinApp = (typeof BUILTIN_APPS)[number];

export const FIRST_PARTY_GITHUB_OWNER = "CapSoftware";

export const RESERVED_ID_WORDS = ["cap", "official"] as const;

export const LIMITS = {
	idMinLength: 3,
	idMaxLength: 40,
	itemIdMaxLength: 40,
	nameMinLength: 2,
	nameMaxLength: 30,
	descriptionMinLength: 10,
	descriptionMaxLength: 140,
	itemNameMaxLength: 30,
	itemDescriptionMaxLength: 80,
	keywordsMax: 8,
	keywordMaxLength: 24,
	categoriesMax: 3,
	backgroundsMax: 24,
	captionStylesMax: 12,
	colorLooksMax: 12,
	settingsMax: 20,
	settingOptionsMax: 50,
	actionsMax: 5,
	actionTitleMaxLength: 30,
	settingLabelMaxLength: 40,
	settingDescriptionMaxLength: 160,
	settingDefaultMaxLength: 500,
	urlMaxLength: 512,
	iconSize: 512,
	iconMaxBytes: 256 * 1024,
	backgroundMinWidth: 1920,
	backgroundMinHeight: 1080,
	backgroundMaxDimension: 7680,
	backgroundMaxBytes: 8 * 1024 * 1024,
	screenshotsMax: 6,
	screenshotWidth: 2000,
	screenshotHeight: 1250,
	screenshotMaxBytes: 2 * 1024 * 1024,
	readmeMaxBytes: 64 * 1024,
	appMaxBytes: 25 * 1024 * 1024,
	captionSizeMin: 12,
	captionSizeMax: 200,
} as const;

export const CONNECTION_TIMEOUT_MS = 10_000;
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export const SIGNATURE_HEADER = "Cap-Signature";
export const TIMESTAMP_HEADER = "Cap-Timestamp";
export const REQUEST_ID_HEADER = "Cap-Request-Id";
export const REQUEST_KIND_HEADER = "Cap-Request-Kind";
export const PUBLIC_KEYS_PATH = "/.well-known/cap-app-store-keys.json";
