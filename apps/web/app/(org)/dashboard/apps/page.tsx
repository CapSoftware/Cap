import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { organizationMembers, organizations } from "@cap/database/schema";
import { and, eq } from "drizzle-orm";
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import AppsClient from "./AppsClient";

export const metadata: Metadata = {
	title: "Apps — Cap",
};

export default async function AppsPage() {
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

	return <AppsClient />;
}
