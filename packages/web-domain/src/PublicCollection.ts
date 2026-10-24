import { Schema } from "effect";

/**
 * Presentation settings for a public collection page (`/c/[id]`), shared by
 * public folders and public spaces. Stored as `{ publicPage: PublicPageSettings }`
 * inside the `settings` JSON column of both `folders` and `spaces`.
 */

export const PublicCollectionLayout = Schema.Literal("grid", "list");
export type PublicCollectionLayout = Schema.Schema.Type<
	typeof PublicCollectionLayout
>;

export const PublicCollectionGridColumns = Schema.Literal(2, 3, 4, 5);
export type PublicCollectionGridColumns = Schema.Schema.Type<
	typeof PublicCollectionGridColumns
>;

/**
 * Which logo (if any) is shown in the public collection header.
 * - `cap`: the Cap logo
 * - `organization`: the organization's own icon
 * - `custom`: a logo uploaded specifically for this collection (`logoUrl`)
 * - `none`: no logo (and no "Powered by Cap" footer)
 */
export const PublicCollectionLogoMode = Schema.Literal(
	"cap",
	"organization",
	"custom",
	"none",
);
export type PublicCollectionLogoMode = Schema.Schema.Type<
	typeof PublicCollectionLogoMode
>;

/** Upper bounds keep stored JSON small and the public page readable. */
export const PUBLIC_PAGE_TITLE_MAX_LENGTH = 80;
export const PUBLIC_PAGE_SUBTITLE_MAX_LENGTH = 160;
export const PUBLIC_PAGE_CTA_LABEL_MAX_LENGTH = 40;
export const PUBLIC_PAGE_CTA_URL_MAX_LENGTH = 512;
/** S3 object keys are capped at 1024 bytes. */
export const PUBLIC_PAGE_LOGO_URL_MAX_LENGTH = 1024;

export const PublicPageSettings = Schema.Struct({
	hideTitle: Schema.optional(Schema.Boolean),
	hideCopyLink: Schema.optional(Schema.Boolean),
	logoMode: Schema.optional(PublicCollectionLogoMode),
	logoUrl: Schema.optional(
		Schema.String.pipe(Schema.maxLength(PUBLIC_PAGE_LOGO_URL_MAX_LENGTH)),
	),
	title: Schema.optional(
		Schema.String.pipe(Schema.maxLength(PUBLIC_PAGE_TITLE_MAX_LENGTH)),
	),
	subtitle: Schema.optional(
		Schema.String.pipe(Schema.maxLength(PUBLIC_PAGE_SUBTITLE_MAX_LENGTH)),
	),
	ctaLabel: Schema.optional(
		Schema.String.pipe(Schema.maxLength(PUBLIC_PAGE_CTA_LABEL_MAX_LENGTH)),
	),
	ctaUrl: Schema.optional(
		Schema.String.pipe(Schema.maxLength(PUBLIC_PAGE_CTA_URL_MAX_LENGTH)),
	),
	layout: Schema.optional(PublicCollectionLayout),
	gridColumns: Schema.optional(PublicCollectionGridColumns),
});
export type PublicPageSettings = Schema.Schema.Type<typeof PublicPageSettings>;

/**
 * The client-writable subset of `PublicPageSettings`, applied as a partial
 * patch merged into the stored value. `logoUrl` is excluded: it is owned by
 * the logo upload action, which is the only writer of collection logo keys.
 */
export const PublicPageSettingsUpdate = PublicPageSettings.omit("logoUrl");
export type PublicPageSettingsUpdate = Schema.Schema.Type<
	typeof PublicPageSettingsUpdate
>;

export const DEFAULT_PUBLIC_PAGE_SETTINGS = {
	hideTitle: false,
	hideCopyLink: false,
	logoMode: "cap",
	logoUrl: "",
	title: "",
	subtitle: "",
	ctaLabel: "",
	ctaUrl: "",
	layout: "grid",
	gridColumns: 4,
} as const satisfies Required<PublicPageSettings>;

/**
 * Merge a stored (possibly partial / null) `PublicPageSettings` onto the
 * defaults so callers always have a fully-resolved presentation config.
 */
export function resolvePublicPageSettings(
	settings: PublicPageSettings | null | undefined,
): Required<PublicPageSettings> {
	return {
		hideTitle: settings?.hideTitle ?? DEFAULT_PUBLIC_PAGE_SETTINGS.hideTitle,
		hideCopyLink:
			settings?.hideCopyLink ?? DEFAULT_PUBLIC_PAGE_SETTINGS.hideCopyLink,
		logoMode: settings?.logoMode ?? DEFAULT_PUBLIC_PAGE_SETTINGS.logoMode,
		logoUrl: settings?.logoUrl ?? DEFAULT_PUBLIC_PAGE_SETTINGS.logoUrl,
		title: settings?.title ?? DEFAULT_PUBLIC_PAGE_SETTINGS.title,
		subtitle: settings?.subtitle ?? DEFAULT_PUBLIC_PAGE_SETTINGS.subtitle,
		ctaLabel: settings?.ctaLabel ?? DEFAULT_PUBLIC_PAGE_SETTINGS.ctaLabel,
		ctaUrl: settings?.ctaUrl ?? DEFAULT_PUBLIC_PAGE_SETTINGS.ctaUrl,
		layout: settings?.layout ?? DEFAULT_PUBLIC_PAGE_SETTINGS.layout,
		gridColumns:
			settings?.gridColumns ?? DEFAULT_PUBLIC_PAGE_SETTINGS.gridColumns,
	};
}
