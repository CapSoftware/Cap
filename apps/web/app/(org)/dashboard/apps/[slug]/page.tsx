import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { organizationMembers, organizations } from "@cap/database/schema";
import type { AppDefinitionType } from "@cap/apps/ui";
import { Apps as AppsService } from "@cap/web-backend";
import { and, eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { MDXRemote } from "next-mdx-remote/rsc";

import { AppDetailsClient } from "../components/AppDetailsClient";
import { runPromise } from "@/lib/server";

import type { SerializableAppDefinition } from "../types";

type PageParams = {
	slug: string;
};

type PageProps = {
	params: Promise<PageParams>;
};

const serializeDefinition = (
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

async function fetchDefinition(
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

export async function generateMetadata(
	props: PageProps,
): Promise<Metadata | undefined> {
	const params = await props.params;
	const definition = await fetchDefinition(params.slug);

	if (!definition) return undefined;

	return {
		title: `${definition.displayName} — Cap Apps`,
		description: definition.description,
	};
}

export default async function AppDetailsPage(props: PageProps) {
	const params = await props.params;
	const { slug } = params;

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

	const definition = await fetchDefinition(slug);

	if (!definition) {
		notFound();
	}

	return (
		<div className="flex flex-col gap-10">
			<AppDetailsClient definition={definition} />
			<div className="rounded-2xl border border-gray-3 bg-gray-1 p-6">
				{definition.content && definition.content.trim().length > 0 ? (
					<article className="prose max-w-none prose-headings:font-semibold">
						<MDXRemote source={definition.content} />
					</article>
				) : (
					<p className="text-sm text-gray-10">
						We&apos;re putting the finishing touches on this guide. Check back soon.
					</p>
				)}
			</div>
		</div>
	);
}
