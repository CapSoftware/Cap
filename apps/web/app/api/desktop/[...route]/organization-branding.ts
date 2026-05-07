import {
	type DesktopOrganization,
	DesktopOrganization as DesktopOrganizationSchema,
	type OrganizationBrandColors,
	OrganizationBrandColors as OrganizationBrandColorsSchema,
	type OrganizationBrandingPatchBody,
	OrganizationHexColor,
	type OrganizationLogoUpdate,
} from "@cap/web-api-contract";

export const EMPTY_ORGANIZATION_BRAND_COLORS = {
	primary: null,
	secondary: null,
	accent: null,
	background: null,
} satisfies OrganizationBrandColors;

export const MAX_ORGANIZATION_LOGO_BYTES = 1024 * 1024;

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

const IMAGE_EXTENSIONS = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/webp": "webp",
	"image/gif": "gif",
	"image/avif": "avif",
} satisfies Record<
	Extract<OrganizationLogoUpdate, { action: "upload" }>["contentType"],
	string
>;

export class OrganizationBrandingValidationError extends Error {}

export type DesktopOrganizationRow = {
	id: string;
	name: string;
	ownerId: string;
	tombstoneAt: Date | null;
	iconUrl: string | null;
	metadata: unknown;
	role: "owner" | "member" | null;
};

export type DecodedOrganizationLogoUpdate =
	| { action: "keep" }
	| { action: "remove" }
	| {
			action: "upload";
			contentType: Extract<
				OrganizationLogoUpdate,
				{ action: "upload" }
			>["contentType"];
			fileName: string;
			data: Uint8Array;
	  };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeColor(value: unknown) {
	if (typeof value !== "string") return null;
	const parsed = OrganizationHexColor.safeParse(value);
	return parsed.success ? parsed.data.toUpperCase() : null;
}

function startsWithBytes(data: Uint8Array, bytes: number[]) {
	return bytes.every((byte, index) => data[index] === byte);
}

function hasAsciiAt(data: Uint8Array, offset: number, value: string) {
	return [...value].every(
		(char, index) => data[offset + index] === char.charCodeAt(0),
	);
}

function isImageDataForContentType(
	data: Uint8Array,
	contentType: Extract<
		OrganizationLogoUpdate,
		{ action: "upload" }
	>["contentType"],
) {
	switch (contentType) {
		case "image/png":
			return startsWithBytes(data, [137, 80, 78, 71, 13, 10, 26, 10]);
		case "image/jpeg":
			return startsWithBytes(data, [255, 216, 255]);
		case "image/webp":
			return (
				data.length >= 12 &&
				hasAsciiAt(data, 0, "RIFF") &&
				hasAsciiAt(data, 8, "WEBP")
			);
		case "image/gif":
			return hasAsciiAt(data, 0, "GIF87a") || hasAsciiAt(data, 0, "GIF89a");
		case "image/avif":
			return (
				data.length >= 12 &&
				hasAsciiAt(data, 4, "ftyp") &&
				(hasAsciiAt(data, 8, "avif") || hasAsciiAt(data, 8, "avis"))
			);
	}
}

export function normalizeOrganizationBrandColors(
	colors: OrganizationBrandColors,
): OrganizationBrandColors {
	return {
		primary: normalizeColor(colors.primary),
		secondary: normalizeColor(colors.secondary),
		accent: normalizeColor(colors.accent),
		background: normalizeColor(colors.background),
	};
}

export function organizationBrandColorsFromMetadata(
	metadata: unknown,
): OrganizationBrandColors {
	if (!isRecord(metadata)) return EMPTY_ORGANIZATION_BRAND_COLORS;
	const branding = metadata.branding;
	if (!isRecord(branding)) return EMPTY_ORGANIZATION_BRAND_COLORS;
	const colors = branding.colors;
	if (!isRecord(colors)) return EMPTY_ORGANIZATION_BRAND_COLORS;

	return normalizeOrganizationBrandColors({
		primary: normalizeColor(colors.primary),
		secondary: normalizeColor(colors.secondary),
		accent: normalizeColor(colors.accent),
		background: normalizeColor(colors.background),
	});
}

export function mergeOrganizationBrandingMetadata(
	metadata: unknown,
	brandColors: OrganizationBrandColors,
) {
	const metadataRecord = isRecord(metadata) ? { ...metadata } : {};
	const brandingRecord = isRecord(metadataRecord.branding)
		? { ...metadataRecord.branding }
		: {};
	const normalizedColors = normalizeOrganizationBrandColors(
		OrganizationBrandColorsSchema.parse(brandColors),
	);

	return {
		...metadataRecord,
		branding: {
			...brandingRecord,
			colors: normalizedColors,
		},
	};
}

export function filterAccessibleOrganizationRows(
	rows: DesktopOrganizationRow[],
	userId: string,
) {
	return rows.filter(
		(row) =>
			row.tombstoneAt === null &&
			(row.ownerId === userId || row.role === "owner" || row.role === "member"),
	);
}

export function toDesktopOrganization(
	row: DesktopOrganizationRow,
	userId: string,
	iconUrl: string | null,
): DesktopOrganization {
	const role =
		row.ownerId === userId || row.role === "owner" ? "owner" : "member";

	return DesktopOrganizationSchema.parse({
		id: row.id,
		name: row.name,
		ownerId: row.ownerId,
		role,
		canEditBrand: role === "owner",
		iconUrl,
		brandColors: organizationBrandColorsFromMetadata(row.metadata),
	});
}

export function canEditOrganizationBranding(
	row: DesktopOrganizationRow,
	userId: string,
) {
	return (
		row.tombstoneAt === null && (row.ownerId === userId || row.role === "owner")
	);
}

export function normalizeOrganizationBrandingPatchBody(
	body: OrganizationBrandingPatchBody,
): OrganizationBrandingPatchBody {
	return {
		brandColors: normalizeOrganizationBrandColors(body.brandColors),
		logo: body.logo ?? { action: "keep" },
	};
}

export function decodeOrganizationLogoUpdate(
	logo: OrganizationBrandingPatchBody["logo"],
): DecodedOrganizationLogoUpdate {
	if (!logo || logo.action === "keep") return { action: "keep" };
	if (logo.action === "remove") return { action: "remove" };

	if (!BASE64_PATTERN.test(logo.data)) {
		throw new OrganizationBrandingValidationError("Invalid logo data");
	}

	const decodedLength = Buffer.byteLength(logo.data, "base64");
	if (decodedLength === 0) {
		throw new OrganizationBrandingValidationError("Logo file is empty");
	}
	if (decodedLength > MAX_ORGANIZATION_LOGO_BYTES) {
		throw new OrganizationBrandingValidationError(
			"Logo file must be less than 1MB",
		);
	}

	const buffer = Buffer.from(logo.data, "base64");
	const data = new Uint8Array(buffer);
	if (!isImageDataForContentType(data, logo.contentType)) {
		throw new OrganizationBrandingValidationError("Logo file type is invalid");
	}

	return {
		action: "upload",
		contentType: logo.contentType,
		fileName: `logo.${IMAGE_EXTENSIONS[logo.contentType]}`,
		data,
	};
}
