"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import {
	organizationMembers,
	organizations,
	users,
} from "@cap/database/schema";
import type { Organisation } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { createSpace as createSpaceAction } from "@/actions/organization/create-space";
import { updateSpace as updateSpaceAction } from "@/actions/organization/update-space";

export async function updateActiveOrganization(
	organizationId: Organisation.OrganisationId,
) {
	const user = await getCurrentUser();
	if (!user) throw new Error("未授权");

	const [organization] = await db()
		.select({ organization: organizations })
		.from(organizations)
		.innerJoin(
			organizationMembers,
			and(
				eq(organizationMembers.organizationId, organizations.id),
				eq(organizationMembers.userId, user.id),
			),
		)
		.where(eq(organizations.id, organizationId));

	if (!organization) throw new Error("未找到组织");

	await db()
		.update(users)
		.set({ activeOrganizationId: organization.organization.id })
		.where(eq(users.id, user.id));

	revalidatePath("/dashboard");
}

export async function createSpace(formData: FormData) {
	try {
		const result = await createSpaceAction(formData);

		if (!result.success) {
			throw new Error(result.error || "创建空间失败");
		}

		return result;
	} catch (error) {
		console.error("创建空间时出错：", error);
		throw error;
	}
}

export async function updateSpace(formData: FormData) {
	try {
		const result = await updateSpaceAction(formData);
		if (!result.success) {
			throw new Error(result.error || "更新空间失败");
		}
		return result;
	} catch (error) {
		console.error("更新空间时出错：", error);
		throw error;
	}
}
