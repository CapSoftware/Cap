import { resolveAppAssetPath } from "@cap/apps";
import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import {
	organizationMembers,
	organizations,
	spaces as spacesTable,
} from "@cap/database/schema";
import type { AppDefinitionType, AppSpace } from "@cap/apps/ui";
import { Apps as AppsService } from "@cap/web-backend";
import { and, eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import { redirect } from "next/navigation";
import { promises as fs } from "node:fs/promises";
import { extname, join } from "node:path";

import { runPromise } from "@/lib/server";

import type { SerializableAppDefinition } from "../../apps/types";

const SUPPORTED_MEDIA_EXTENSIONS = new Set([
	".jpg",
	".jpeg",
	".png",
	".webp",
	".gif",
]);

const mediaCollator = new Intl.Collator(undefined, {
	numeric: true,
	sensitivity: "base",
});

export type AppMediaAsset = {
	readonly filename: string;
	readonly src: string;
};

export type OwnerContext = {
	readonly user: NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>;
	readonly organizationId: string;
};

const determineMimeType = (filePath: string): string => {
	switch (extname(filePath).toLowerCase()) {
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".png":
			return "image/png";
		case ".webp":
			return "image/webp";
		case ".gif":
			return "image/gif";
		default:
			return "application/octet-stream";
	}
};

export const serializeDefinition = (
	definition: AppDefinitionType,
): SerializableAppDefinition => ({
	slug: definition.slug,
	displayName: definition.displayName,
	description: definition.description,
	icon: definition.icon,
	category: definition.category,
	requiredEnvVars: Array.from(definition.requiredEnvVars),
	image: definition.image,
	documentation: definition.documentation,
	content: definition.content,
	contentPath: Option.getOrNull(
		definition.contentPath as unknown as Option.Option<string>,
	),
	publisher: {
		name: definition.publisher.name,
		email: definition.publisher.email,
	},
});

export async function fetchDefinition(
	slug: string,
): Promise<SerializableAppDefinition | null> {
	return Effect.flatMap(AppsService, (apps) => apps.listDefinitions()).pipe(
		Effect.map((definitions) =>
			definitions.find((definition) => definition.slug === slug) ?? null,
		),
		Effect.map((definition) =>
			definition ? serializeDefinition(definition) : null,
		),
		runPromise,
	);
}

export async function requireActiveOrganizationOwner(): Promise<OwnerContext> {
	const user = await getCurrentUser();

	if (!user) {
		redirect("/login");
	}

	if (!user.activeOrganizationId) {
		redirect("/dashboard");
	}

	const [organizationAccess] = await db()
		.select({
			ownerId: organizations.ownerId,
			memberRole: organizationMembers.role,
		})
		.from(organizations)
		.leftJoin(
			organizationMembers,
			and(
				eq(organizationMembers.organizationId, organizations.id),
				eq(organizationMembers.userId, user.id),
			),
		)
		.where(eq(organizations.id, user.activeOrganizationId))
		.limit(1);

	const isOwner =
		organizationAccess?.ownerId === user.id ||
		organizationAccess?.memberRole === "owner";

	if (!isOwner) {
		redirect("/dashboard/caps");
	}

	return { user, organizationId: user.activeOrganizationId };
}

export async function loadAppSpaces(
	organizationId: string,
): Promise<AppSpace[]> {
	const spaceRows = await db()
		.select({
			id: spacesTable.id,
			name: spacesTable.name,
		})
		.from(spacesTable)
		.where(eq(spacesTable.organizationId, organizationId))
		.orderBy(spacesTable.name);

	return [
		{
			id: organizationId,
			name: "All spaces",
		},
		...spaceRows.map((space) => ({ id: space.id, name: space.name })),
	];
}

const readMediaFile = async (
	slug: string,
	filename: string,
): Promise<AppMediaAsset | null> => {
	const resolvedPath = resolveAppAssetPath(
		slug,
		join("./media", filename),
	);

	if (!resolvedPath) {
		return null;
	}

	try {
		const buffer = await fs.readFile(resolvedPath);
		const mimeType = determineMimeType(resolvedPath);
		return {
			filename,
			src: `data:${mimeType};base64,${buffer.toString("base64")}`,
		};
	} catch (error: unknown) {
		console.warn(
			`Failed to read media asset '${filename}' for app '${slug}':`,
			error,
		);
		return null;
	}
};

export async function loadAppMediaAssets(
	slug: string,
): Promise<AppMediaAsset[]> {
	const mediaDirectory = resolveAppAssetPath(slug, "./media");
	if (!mediaDirectory) {
		return [];
	}

	let entries: string[];
	try {
		entries = await fs.readdir(mediaDirectory);
	} catch (error: unknown) {
		console.warn(
			`Failed to list media assets for app '${slug}' in '${mediaDirectory}':`,
			error,
		);
		return [];
	}

	const files = entries
		.filter((entry) =>
			SUPPORTED_MEDIA_EXTENSIONS.has(extname(entry).toLowerCase()),
		)
		.sort((a, b) => mediaCollator.compare(a, b));

	const assets = await Promise.all(
		files.map((filename) => readMediaFile(slug, filename)),
	);

	return assets.filter(
		(asset): asset is AppMediaAsset => asset !== null,
	);
}
