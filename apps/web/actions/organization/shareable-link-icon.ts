"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { organizations } from "@cap/database/schema";
import { userIsPro } from "@cap/utils";
import { ImageUploads } from "@cap/web-backend";
import { Organisation } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import { revalidatePath } from "next/cache";
import { runPromise } from "@/lib/server";
import { requireOrganizationSettingsManager } from "./authorization";

const allowedImageTypes = new Set(["image/jpeg", "image/png"]);
const maxIconSizeBytes = 1024 * 1024;

async function getManageableProOrganization(
	organizationId: Organisation.OrganisationId,
) {
	const user = await getCurrentUser();

	if (!user) {
		throw new Error("Unauthorized");
	}

	await requireOrganizationSettingsManager(user.id, organizationId);

	if (!userIsPro(user)) {
		throw new Error("Upgrade required to customize shareable link branding");
	}

	const [organization] = await db()
		.select({
			id: organizations.id,
			iconUrl: organizations.iconUrl,
			settings: organizations.settings,
			shareableLinkIconUrl: organizations.shareableLinkIconUrl,
		})
		.from(organizations)
		.where(eq(organizations.id, organizationId))
		.limit(1);

	if (!organization) {
		throw new Error("Organization not found");
	}

	return organization;
}

function validateIcon(file: File) {
	if (!file || file.size === 0) {
		throw new Error("No file provided");
	}

	if (!allowedImageTypes.has(file.type.toLowerCase())) {
		throw new Error("Please select a PNG or JPEG image");
	}

	if (file.size > maxIconSizeBytes) {
		throw new Error("File size must be 1MB or less");
	}
}

function revalidateOrganizationBrandingPaths() {
	revalidatePath("/dashboard/caps");
	revalidatePath("/dashboard/settings/organization");
	revalidatePath("/dashboard/settings/organization/preferences");
}

export async function uploadShareableLinkIcon(formData: FormData) {
	const organizationId = Organisation.OrganisationId.make(
		String(formData.get("organizationId")),
	);
	const file = formData.get("icon");

	if (!(file instanceof File)) {
		throw new Error("No file provided");
	}

	validateIcon(file);
	const organization = await getManageableProOrganization(organizationId);
	const arrayBuffer = await file.arrayBuffer();

	await Effect.gen(function* () {
		const imageUploads = yield* ImageUploads;

		yield* imageUploads.applyUpdate({
			payload: Option.some({
				contentType: file.type,
				fileName: file.name,
				data: new Uint8Array(arrayBuffer),
			}),
			existing: Option.fromNullable(organization.shareableLinkIconUrl),
			keyPrefix: `organizations/${organization.id}/shareable-links`,
			update: (db, urlOrKey) =>
				db
					.update(organizations)
					.set({ shareableLinkIconUrl: urlOrKey })
					.where(eq(organizations.id, organization.id)),
		});
	}).pipe(runPromise);

	revalidateOrganizationBrandingPaths();

	return { success: true };
}

export async function removeShareableLinkIcon(
	organizationId: Organisation.OrganisationId,
) {
	const organization = await getManageableProOrganization(organizationId);

	await Effect.gen(function* () {
		const imageUploads = yield* ImageUploads;

		yield* imageUploads.applyUpdate({
			payload: Option.none(),
			existing: Option.fromNullable(organization.shareableLinkIconUrl),
			keyPrefix: `organizations/${organization.id}/shareable-links`,
			update: (db, urlOrKey) =>
				db
					.update(organizations)
					.set({ shareableLinkIconUrl: urlOrKey })
					.where(eq(organizations.id, organization.id)),
		});
	}).pipe(runPromise);

	revalidateOrganizationBrandingPaths();

	return { success: true };
}

export async function updateShareableLinkIconPreference({
	organizationId,
	useOrganizationIcon,
}: {
	organizationId: Organisation.OrganisationId;
	useOrganizationIcon: boolean;
}) {
	const organization = await getManageableProOrganization(organizationId);

	if (useOrganizationIcon && !organization.iconUrl) {
		throw new Error(
			"Add an organization icon before using it for shareable links",
		);
	}

	await db()
		.update(organizations)
		.set({
			settings: {
				...(organization.settings ?? {}),
				shareableLinkUseOrganizationIcon: useOrganizationIcon,
			},
		})
		.where(eq(organizations.id, organization.id));

	revalidateOrganizationBrandingPaths();

	return { success: true };
}
