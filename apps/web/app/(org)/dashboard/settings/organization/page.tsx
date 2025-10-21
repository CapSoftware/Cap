import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import {
	organizationMembers,
	organizations,
	users,
} from "@cap/database/schema";
import { and, eq } from "drizzle-orm";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Organization } from "./Organization";

export const metadata: Metadata = {
	title: "Organization Settings — Cap",
};

export default async function OrganizationPage() {
	const user = await getCurrentUser();

	if (!user) {
		redirect("/auth/signin");
	}

	const [member] = await db()
		.select({
			role: organizationMembers.role,
		})
		.from(organizationMembers)
		.limit(1)
		.leftJoin(
			organizations,
			eq(organizationMembers.organizationId, organizations.id),
		)
		.where(
			and(
				eq(organizationMembers.userId, user.id),
				eq(organizations.id, user.activeOrganizationId),
			),
		);

	if (!member || member.role !== "owner") {
		redirect("/dashboard/caps");
	}

	return <Organization />;
}
