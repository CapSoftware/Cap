import { db } from "@cap/database";
import {
	authApiKeys,
	organizationMembers,
	organizations,
	users,
} from "@cap/database/schema";
import { userIsPro } from "@cap/utils";
import { zValidator } from "@hono/zod-validator";
import { eq, or } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

export const app = new Hono();

app.get(
	"/",
	zValidator(
		"header",
		z.object({
			authorization: z.string(),
		}),
	),
	async (c) => {
		const { authorization } = c.req.valid("header");
		const token = authorization.split(" ")[1];

		if (!token || token.length !== 36) return c.text("Unauthorized", 401);

		const rows = await db()
			.select({ user: users })
			.from(users)
			.leftJoin(authApiKeys, eq(users.id, authApiKeys.userId))
			.where(eq(authApiKeys.id, token));

		const user = rows[0]?.user;
		if (!user) return c.text("Unauthorized", 401);

		const orgRows = await db()
			.select({
				id: organizations.id,
				name: organizations.name,
				createdAt: organizations.createdAt,
			})
			.from(organizations)
			.leftJoin(
				organizationMembers,
				eq(organizations.id, organizationMembers.organizationId),
			)
			.where(
				or(
					eq(organizations.ownerId, user.id),
					eq(organizationMembers.userId, user.id),
				),
			)
			.groupBy(organizations.id, organizations.name, organizations.createdAt)
			.orderBy(organizations.createdAt);

		return c.json({
			user: {
				id: user.id,
				email: user.email,
				name: user.name ?? null,
				lastName: user.lastName ?? null,
				isPro: userIsPro(user),
				activeOrganizationId: user.activeOrganizationId ?? null,
				defaultOrgId: user.defaultOrgId ?? null,
			},
			organizations: orgRows.map((o) => ({ id: o.id, name: o.name })),
		});
	},
);
