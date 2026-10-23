"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { nanoId } from "@cap/database/helpers";
import {
	agentApiKeys,
	authApiKeys,
	organizationMembers,
	organizations,
	sessions,
	users,
} from "@cap/database/schema";
import type { Organisation } from "@cap/web-domain";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import {
	agentScopeProfiles,
	createAgentAccessToken,
	hashAgentSecret,
	isAgentScopeProfile,
} from "@/lib/agent-auth";
import { isRateLimited, RATE_LIMIT_IDS } from "@/lib/rate-limit";

export type CliApiKeySummary = {
	id: string;
	name: string;
	scopes: string[];
	createdAt: string;
	lastUsedAt: string | null;
	expiresAt: string;
};

const cliApiKeyExpiryDays = new Set([30, 90, 365]);

export async function patchAccountSettings(
	firstName?: string,
	lastName?: string,
	defaultOrgId?: Organisation.OrganisationId,
) {
	const currentUser = await getCurrentUser();
	if (!currentUser) throw new Error("Unauthorized");

	const updatePayload: Partial<{
		name: string;
		lastName: string;
		defaultOrgId: Organisation.OrganisationId;
	}> = {};

	if (firstName !== undefined) updatePayload.name = firstName;
	if (lastName !== undefined) updatePayload.lastName = lastName;
	if (defaultOrgId !== undefined) {
		const [userOrganization] = await db()
			.select({
				id: organizations.id,
			})
			.from(organizations)
			.leftJoin(
				organizationMembers,
				and(
					eq(organizations.id, organizationMembers.organizationId),
					eq(organizationMembers.userId, currentUser.id),
				),
			)
			.where(
				and(
					eq(organizations.id, defaultOrgId),
					or(
						eq(organizations.ownerId, currentUser.id),
						eq(organizationMembers.userId, currentUser.id),
					),
				),
			)
			.limit(1);

		if (!userOrganization)
			throw new Error(
				"Forbidden: User does not have access to the specified organization",
			);

		updatePayload.defaultOrgId = defaultOrgId;
	}

	await db()
		.update(users)
		.set(updatePayload)
		.where(eq(users.id, currentUser.id));

	revalidatePath("/dashboard/settings/account");
}

export async function listCliApiKeys(): Promise<CliApiKeySummary[]> {
	const currentUser = await getCurrentUser();
	if (!currentUser) throw new Error("Unauthorized");

	const keys = await db()
		.select({
			id: agentApiKeys.id,
			name: agentApiKeys.name,
			scopes: agentApiKeys.scopes,
			createdAt: agentApiKeys.createdAt,
			lastUsedAt: agentApiKeys.lastUsedAt,
			expiresAt: agentApiKeys.expiresAt,
		})
		.from(agentApiKeys)
		.where(
			and(
				eq(agentApiKeys.userId, currentUser.id),
				isNull(agentApiKeys.revokedAt),
			),
		)
		.orderBy(desc(agentApiKeys.createdAt));

	return keys.map((key) => ({
		id: key.id,
		name: key.name,
		scopes: [...key.scopes],
		createdAt: key.createdAt.toISOString(),
		lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
		expiresAt: key.expiresAt.toISOString(),
	}));
}

export async function createCliApiKey(input: {
	name: string;
	profile: string;
	expiresInDays: number;
}): Promise<{ token: string; key: CliApiKeySummary }> {
	const currentUser = await getCurrentUser();
	if (!currentUser) throw new Error("Unauthorized");

	const name = input.name.trim();
	if (name.length === 0 || name.length > 100) {
		throw new Error("The key name must be between 1 and 100 characters");
	}
	if (!isAgentScopeProfile(input.profile)) {
		throw new Error("Unknown access profile");
	}
	if (!cliApiKeyExpiryDays.has(input.expiresInDays)) {
		throw new Error("Unknown expiry");
	}

	// Same bucket as the CLI OAuth authorize page: both mint agent credentials.
	if (
		await isRateLimited(RATE_LIMIT_IDS.AGENT_AUTHORIZATION, {
			key: `agent-authorization:${currentUser.id}`,
		})
	) {
		throw new Error("Too many API key requests. Try again later.");
	}

	const token = createAgentAccessToken();
	const now = new Date();
	const expiresAt = new Date(
		now.getTime() + input.expiresInDays * 24 * 60 * 60 * 1000,
	);
	const scopes = agentScopeProfiles[input.profile];
	const id = nanoId();
	await db()
		.insert(agentApiKeys)
		.values({
			id,
			userId: currentUser.id,
			tokenHash: hashAgentSecret(token),
			name,
			scopes,
			expiresAt,
		});

	revalidatePath("/dashboard/settings/account");
	return {
		token,
		key: {
			id,
			name,
			scopes: [...scopes],
			createdAt: now.toISOString(),
			lastUsedAt: null,
			expiresAt: expiresAt.toISOString(),
		},
	};
}

export async function revokeCliApiKey(keyId: string): Promise<void> {
	const currentUser = await getCurrentUser();
	if (!currentUser) throw new Error("Unauthorized");

	await db()
		.update(agentApiKeys)
		.set({ revokedAt: new Date() })
		.where(
			and(
				eq(agentApiKeys.id, keyId),
				eq(agentApiKeys.userId, currentUser.id),
				isNull(agentApiKeys.revokedAt),
			),
		);

	revalidatePath("/dashboard/settings/account");
}

export async function signOutAllDevices() {
	const currentUser = await getCurrentUser();
	if (!currentUser) throw new Error("Unauthorized");

	await db().transaction(async (tx) => {
		await tx
			.update(users)
			.set({ authSessionVersion: sql`${users.authSessionVersion} + 1` })
			.where(eq(users.id, currentUser.id));
		await tx.delete(sessions).where(eq(sessions.userId, currentUser.id));
		await tx.delete(authApiKeys).where(eq(authApiKeys.userId, currentUser.id));
		await tx
			.update(agentApiKeys)
			.set({ revokedAt: new Date() })
			.where(
				and(
					eq(agentApiKeys.userId, currentUser.id),
					isNull(agentApiKeys.revokedAt),
				),
			);
	});
}
