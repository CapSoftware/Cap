import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { nanoId } from "@cap/database/helpers";
import {
	organizationMembers,
	organizations,
	users,
} from "@cap/database/schema";
import { and, eq, ne, or } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import type { NextRequest } from "next/server";

export async function POST(request: NextRequest) {
	const user = await getCurrentUser();
	const { firstName, lastName } = await request.json();

	if (!user) {
		console.error("User not found");
		return Response.json({ error: true }, { status: 401 });
	}

	await db()
		.update(users)
		.set({
			name: firstName,
			lastName: lastName,
		})
		.where(eq(users.id, user.id));

	let fullName = firstName;
	if (lastName) {
		fullName += ` ${lastName}`;
	}

	const memberButNotOwner = await db()
		.select()
		.from(organizationMembers)
		.leftJoin(
			organizations,
			eq(organizationMembers.organizationId, organizations.id),
		)
		.where(
			and(
				eq(organizationMembers.userId, user.id),
				ne(organizations.ownerId, user.id),
			),
		)
		.limit(1);

	console.log("memberButNotOwner", memberButNotOwner);

	const isMemberOfOrganization = memberButNotOwner.length > 0;

	console.log("isMemberOfOrganization", isMemberOfOrganization);

	const [organization] = await db()
		.select()
		.from(organizations)
		.where(
			or(
				eq(organizations.ownerId, user.id),
				eq(organizationMembers.userId, user.id),
			),
		)
		.leftJoin(
			organizationMembers,
			eq(organizations.id, organizationMembers.organizationId),
		);

	if (!organization) {
		const organizationId = nanoId();

		await db()
			.insert(organizations)
			.values({
				id: organizationId,
				ownerId: user.id,
				name: `${fullName}'s Organization`,
			});

		await db().insert(organizationMembers).values({
			id: nanoId(),
			userId: user.id,
			role: "owner",
			organizationId,
		});

		await db()
			.update(users)
			.set({ activeOrganizationId: organizationId })
			.where(eq(users.id, user.id));
	}

	revalidatePath("/onboarding");
	revalidatePath("/dashboard");

	return Response.json(
		{
			success: true,
			message: "Onboarding completed successfully",
			isMemberOfOrganization,
		},
		{ status: 200 },
	);
}
