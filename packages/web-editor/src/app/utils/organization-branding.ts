import type {
	DesktopOrganization,
	OrganizationBrandColors,
	OrganizationBrandingPatchBody,
} from "@cap/web-api-contract";
import { createEffect, createMemo, createSignal } from "solid-js";
import { recordingSettingsStore } from "~/store";

export type { DesktopOrganization, OrganizationBrandColors };

export type OrganizationAvailability =
	| "signed-out"
	| "loading"
	| "available"
	| "unavailable";

export const EMPTY_ORGANIZATION_BRAND_COLORS = {
	primary: null,
	secondary: null,
	accent: null,
	background: null,
} satisfies OrganizationBrandColors;

export const ORGANIZATION_BRAND_COLOR_LABELS = {
	primary: "Primary",
	secondary: "Secondary",
	accent: "Accent",
	background: "Background",
} satisfies Record<keyof OrganizationBrandColors, string>;

export const ORGANIZATION_BRAND_COLOR_KEYS = [
	"primary",
	"secondary",
	"accent",
	"background",
] as const;

export type OrganizationBrandColorKey =
	(typeof ORGANIZATION_BRAND_COLOR_KEYS)[number];

export type OrganizationBrandColorSwatch = {
	key: OrganizationBrandColorKey;
	label: string;
	color: string;
};

export const ORGANIZATION_BRAND_COLOR_DEFAULTS = {
	primary: "#4785FF",
	secondary: "#FFFFFF",
	accent: "#FF4766",
	background: "#000000",
} satisfies Record<keyof OrganizationBrandColors, string>;

export const ORGANIZATION_LOGO_MAX_BYTES = 1024 * 1024;

export const ORGANIZATION_LOGO_CONTENT_TYPES = [
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif",
	"image/avif",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

function isBrandColor(value: unknown): value is string | null {
	return value === null || (typeof value === "string" && HEX_COLOR.test(value));
}

function parseBrandColors(value: unknown): OrganizationBrandColors | null {
	if (!isRecord(value)) return null;
	const { primary, secondary, accent, background } = value;
	return isBrandColor(primary) &&
		isBrandColor(secondary) &&
		isBrandColor(accent) &&
		isBrandColor(background)
		? { primary, secondary, accent, background }
		: null;
}

function normalizeBrandColorsForCache(value: unknown): OrganizationBrandColors {
	const colors = parseBrandColors(value) ?? EMPTY_ORGANIZATION_BRAND_COLORS;

	return {
		primary: colors.primary?.toUpperCase() ?? null,
		secondary: colors.secondary?.toUpperCase() ?? null,
		accent: colors.accent?.toUpperCase() ?? null,
		background: colors.background?.toUpperCase() ?? null,
	};
}

function isOrganizationRole(
	value: unknown,
): value is DesktopOrganization["role"] {
	return value === "owner" || value === "admin" || value === "member";
}

function parseDesktopOrganization(value: Record<string, unknown>) {
	const { id, name, ownerId, role, canEditBrand, iconUrl } = value;
	if (
		typeof id !== "string" ||
		typeof name !== "string" ||
		typeof ownerId !== "string" ||
		!isOrganizationRole(role) ||
		typeof canEditBrand !== "boolean" ||
		(iconUrl !== null && typeof iconUrl !== "string") ||
		!parseBrandColors(value.brandColors)
	)
		return null;
	return { id, name, ownerId, role, canEditBrand, iconUrl };
}

export function normalizeDesktopOrganization(
	value: unknown,
): DesktopOrganization | null {
	if (!isRecord(value)) return null;
	const parsed = parseDesktopOrganization(value);
	if (parsed)
		return {
			...parsed,
			brandColors: normalizeBrandColorsForCache(value.brandColors),
		};
	if (typeof value.id !== "string" || typeof value.name !== "string")
		return null;

	const role = value.role === "owner" ? "owner" : "member";

	return {
		id: value.id,
		name: value.name,
		ownerId: typeof value.ownerId === "string" ? value.ownerId : "",
		role,
		canEditBrand:
			typeof value.canEditBrand === "boolean"
				? value.canEditBrand
				: role === "owner",
		iconUrl: typeof value.iconUrl === "string" ? value.iconUrl : null,
		brandColors: normalizeBrandColorsForCache(value.brandColors),
	};
}

export function getSelectedOrganizationId(
	organizations: DesktopOrganization[],
	storedId?: string | null,
) {
	if (
		storedId &&
		(organizations.length === 0 ||
			organizations.some((org) => org.id === storedId))
	) {
		return storedId;
	}

	return organizations[0]?.id ?? null;
}

export function getOrganizationBrandColorSwatches(
	organization: DesktopOrganization | null | undefined,
) {
	if (!organization) return [];

	return ORGANIZATION_BRAND_COLOR_KEYS.flatMap((key) => {
		const color = organization.brandColors[key];
		if (!color) return [];

		return {
			key,
			label: ORGANIZATION_BRAND_COLOR_LABELS[key],
			color,
		};
	});
}

function normalizeDesktopOrganizations(values: unknown) {
	if (!Array.isArray(values)) return [];
	return values.flatMap((value) => {
		const organization = normalizeDesktopOrganization(value);
		return organization ? [organization] : [];
	});
}

const [webOrganizations, setWebOrganizations] = createSignal<
	DesktopOrganization[]
>([]);
const [webAvailability, setWebAvailability] =
	createSignal<OrganizationAvailability>("loading");
const [webRefreshing, setWebRefreshing] = createSignal(false);
let webOrganizationRefreshPromise: Promise<void> | null = null;
let webOrganizationUserId = "";
let webOrganizationGeneration = 0;

export function createOrganizationsQuery() {
	const userId =
		(window as Window & { capWebEditorUserId?: string }).capWebEditorUserId ??
		"";
	if (userId !== webOrganizationUserId) {
		webOrganizationUserId = userId;
		webOrganizationGeneration++;
		webOrganizationRefreshPromise = null;
		setWebOrganizations([]);
		setWebAvailability("loading");
	}
	const refresh = async () => {
		if (webOrganizationRefreshPromise) return webOrganizationRefreshPromise;
		const generation = webOrganizationGeneration;
		setWebRefreshing(true);
		const promise = (async () => {
			const response = await fetch("/api/desktop/organizations", {
				credentials: "same-origin",
				cache: "no-store",
			});
			if (response.status === 401) {
				if (generation !== webOrganizationGeneration) return;
				setWebOrganizations([]);
				setWebAvailability("signed-out");
				return;
			}
			if (!response.ok) throw new Error("Unable to load organizations");
			const result: unknown = await response.json();
			if (!Array.isArray(result))
				throw new Error("Organization list was invalid");
			if (generation !== webOrganizationGeneration) return;
			setWebOrganizations(normalizeDesktopOrganizations(result));
			setWebAvailability("available");
		})()
			.catch((error: unknown) => {
				if (generation === webOrganizationGeneration)
					setWebAvailability("unavailable");
				throw error;
			})
			.finally(() => {
				if (generation === webOrganizationGeneration) setWebRefreshing(false);
				if (webOrganizationRefreshPromise === promise)
					webOrganizationRefreshPromise = null;
			});
		webOrganizationRefreshPromise = promise;
		setWebAvailability("loading");
		return promise;
	};

	createEffect(() => {
		if (webAvailability() !== "loading" || webOrganizationRefreshPromise)
			return;
		void refresh().catch(console.error);
	});

	return {
		availability: webAvailability,
		organizations: webOrganizations,
		refresh,
		refreshing: webRefreshing,
		signedIn: () => webAvailability() === "available",
	};
}

export function createSelectedOrganization() {
	const organizationQuery = createOrganizationsQuery();
	const settings = recordingSettingsStore.createQuery();

	const selectedOrganizationId = createMemo(() =>
		getSelectedOrganizationId(
			organizationQuery.organizations(),
			settings.data?.organizationId ?? null,
		),
	);

	const selectedOrganization = createMemo(() => {
		const id = selectedOrganizationId();
		return (
			organizationQuery
				.organizations()
				.find((organization) => organization.id === id) ?? null
		);
	});

	const setSelectedOrganizationId = async (organizationId: string | null) => {
		await recordingSettingsStore.set({ organizationId });
		await settings.refetch();
	};

	createEffect(() => {
		const storedId = settings.data?.organizationId ?? null;
		const selectedId = selectedOrganizationId();
		if (storedId === selectedId) return;
		if (!storedId && !selectedId) return;
		void setSelectedOrganizationId(selectedId).catch(console.error);
	});

	return {
		...organizationQuery,
		settings,
		selectedOrganization,
		selectedOrganizationId,
		setSelectedOrganizationId,
	};
}

export async function encodeFileAsBase64(file: File) {
	const bytes = new Uint8Array(await file.arrayBuffer());
	const chunkSize = 0x8000;
	const chunks: string[] = [];

	for (let index = 0; index < bytes.length; index += chunkSize) {
		chunks.push(
			String.fromCharCode(...bytes.subarray(index, index + chunkSize)),
		);
	}

	return btoa(chunks.join(""));
}

function getResponseError(body: unknown) {
	if (isRecord(body) && typeof body.error === "string") return body.error;
	return "Failed to update organization branding";
}

export async function updateOrganizationBranding(
	organizationId: string,
	body: OrganizationBrandingPatchBody,
) {
	const generation = webOrganizationGeneration;
	const response = await fetch(
		`/api/desktop/organizations/${encodeURIComponent(organizationId)}/branding`,
		{
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			credentials: "same-origin",
			body: JSON.stringify(body),
		},
	);
	const result: unknown = response.headers
		.get("Content-Type")
		?.startsWith("application/json")
		? await response.json()
		: {
				error:
					response.status === 401
						? "Please sign in to continue"
						: "Failed to update organization branding",
			};
	if (!response.ok) throw new Error(getResponseError(result));
	const organization = normalizeDesktopOrganization(result);
	if (!organization || organization.id !== organizationId)
		throw new Error("Organization branding response was invalid");
	if (generation === webOrganizationGeneration) {
		setWebOrganizations((current) =>
			current.map((existing) =>
				existing.id === organization.id ? organization : existing,
			),
		);
	}
	return organization;
}
