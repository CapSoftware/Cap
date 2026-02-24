import { STRIPE_AVAILABLE, stripe } from "@cap/utils";
import { type ImageUpload, Organisation, User } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import type { MySql2Database } from "drizzle-orm/mysql2";
import type { Adapter } from "next-auth/adapters";
import type Stripe from "stripe";
import { nanoId } from "../helpers.ts";
import {
	accounts,
	organizationInvites,
	organizationMembers,
	organizations,
	sessions,
	users,
	verificationTokens,
} from "../schema.ts";

export function DrizzleAdapter(db: MySql2Database): Adapter {
	return {
		async createUser(userData: any) {
			const normalizedEmail = (userData.email as string)?.toLowerCase() ?? "";
			const userId = User.UserId.make(nanoId());
			await db.transaction(async (tx) => {
				const [pendingInvite] = await tx
					.select({ id: organizationInvites.id })
					.from(organizationInvites)
					.where(
						and(
							eq(organizationInvites.invitedEmail, normalizedEmail),
							eq(organizationInvites.status, "pending"),
						),
					)
					.limit(1);

				await tx.insert(users).values({
					id: userId,
					email: normalizedEmail,
					emailVerified: userData.emailVerified,
					name: userData.name,
					image: userData.image,
					activeOrganizationId: Organisation.OrganisationId.make(""),
				});

				if (pendingInvite) {
					return;
				}

				const organizationId = Organisation.OrganisationId.make(nanoId());

				await tx.insert(organizations).values({
					id: organizationId,
					ownerId: userId,
					name: "My Organization",
				});

				await tx.insert(organizationMembers).values({
					id: nanoId(),
					organizationId,
					userId,
					role: "owner",
				});

				await tx
					.update(users)
					.set({
						activeOrganizationId: organizationId,
						defaultOrgId: organizationId,
					})
					.where(eq(users.id, userId));
			});

			const rows = await db
				.select()
				.from(users)
				.where(eq(users.id, userId))
				.limit(1);
			let row = rows[0];
			if (!row) throw new Error("User not found");

			if (STRIPE_AVAILABLE()) {
				const existingCustomers = await stripe().customers.list({
					email: normalizedEmail,
					limit: 1,
				});

				let customer: Stripe.Customer;
				if (existingCustomers.data.length > 0 && existingCustomers.data[0]) {
					customer = existingCustomers.data[0];

					customer = await stripe().customers.update(customer.id, {
						metadata: {
							...customer.metadata,
							userId: row.id,
						},
					});
				} else {
					customer = await stripe().customers.create({
						email: normalizedEmail,
						metadata: {
							userId: row.id,
						},
					});
				}

				const subscriptions = await stripe().subscriptions.list({
					customer: customer.id,
					status: "active",
					limit: 100,
				});

				const inviteQuota = subscriptions.data.reduce((total, sub) => {
					return (
						total +
						sub.items.data.reduce(
							(subTotal, item) => subTotal + (item.quantity || 1),
							0,
						)
					);
				}, 0);

				const mostRecentSubscription = subscriptions.data[0];

				await db
					.update(users)
					.set({
						stripeCustomerId: customer.id,
						...(mostRecentSubscription && {
							stripeSubscriptionId: mostRecentSubscription.id,
							stripeSubscriptionStatus: mostRecentSubscription.status,
							inviteQuota: inviteQuota || 1,
						}),
					})
					.where(eq(users.id, row.id));

				const [updatedRow] = await db
					.select()
					.from(users)
					.where(eq(users.id, row.id))
					.limit(1);
				if (updatedRow) {
					row = updatedRow;
				}
			}

			return row;
		},
		async getUser(id) {
			const rows = await db
				.select()
				.from(users)
				.where(eq(users.id, User.UserId.make(id)))
				.limit(1);
			const row = rows[0];
			return row ?? null;
		},
		async getUserByEmail(email) {
			const normalizedEmail = email?.toLowerCase() ?? "";
			const rows = await db
				.select()
				.from(users)
				.where(eq(users.email, normalizedEmail))
				.limit(1)
				.catch((e) => {
					throw e;
				});
			const row = rows[0];
			return row ?? null;
		},
		async getUserByAccount({ providerAccountId, provider }) {
			const rows = await db
				.select()
				.from(users)
				.innerJoin(accounts, eq(users.id, accounts.userId))
				.where(
					and(
						eq(accounts.providerAccountId, providerAccountId),
						eq(accounts.provider, provider),
					),
				)
				.limit(1);
			const row = rows[0];
			return row?.users ?? null;
		},
		async updateUser({ id, image, ...userData }) {
			if (!id) throw new Error("User not found");
			await db
				.update(users)
				.set({
					...userData,
					image: image as ImageUpload.ImageUrlOrKey | null,
				})
				.where(eq(users.id, User.UserId.make(id)));
			const rows = await db
				.select()
				.from(users)
				.where(eq(users.id, User.UserId.make(id)))
				.limit(1);
			const row = rows[0];
			if (!row) throw new Error("User not found");
			return row;
		},
		async deleteUser(userId) {
			await db.delete(users).where(eq(users.id, User.UserId.make(userId)));
		},
		async linkAccount(account: any) {
			await db.insert(accounts).values({
				id: User.UserId.make(nanoId()),
				userId: account.userId,
				type: account.type,
				provider: account.provider,
				providerAccountId: account.providerAccountId,
				access_token: account.access_token,
				expires_in: account.expires_in as number,
				id_token: account.id_token,
				refresh_token: account.refresh_token,
				refresh_token_expires_in: account.refresh_token_expires_in as number,
				scope: account.scope,
				token_type: account.token_type,
			});
		},
		async unlinkAccount({ providerAccountId, provider }: any) {
			await db
				.delete(accounts)
				.where(
					and(
						eq(accounts.providerAccountId, providerAccountId),
						eq(accounts.provider, provider),
					),
				);
		},
		async createSession(data) {
			await db.insert(sessions).values({
				id: nanoId(),
				expires: data.expires,
				sessionToken: data.sessionToken,
				userId: User.UserId.make(data.userId),
			});
			const rows = await db
				.select()
				.from(sessions)
				.where(eq(sessions.sessionToken, data.sessionToken))
				.limit(1);
			const row = rows[0];
			if (!row) throw new Error("User not found");
			return row;
		},
		async getSessionAndUser(sessionToken) {
			const rows = await db
				.select({
					user: users,
					session: {
						id: sessions.id,
						userId: sessions.userId,
						sessionToken: sessions.sessionToken,
						expires: sessions.expires,
					},
				})
				.from(sessions)
				.innerJoin(users, eq(users.id, sessions.userId))
				.where(eq(sessions.sessionToken, sessionToken))
				.limit(1);
			const row = rows[0];
			if (!row) return null;
			const { user, session } = row;
			return {
				user,
				session: {
					id: session.id,
					userId: User.UserId.make(session.userId),
					sessionToken: session.sessionToken,
					expires: session.expires,
				},
			};
		},
		async updateSession(session: any) {
			await db
				.update(sessions)
				.set(session as any)
				.where(eq(sessions.sessionToken, session.sessionToken));
			const rows = await db
				.select()
				.from(sessions)
				.where(eq(sessions.sessionToken, session.sessionToken))
				.limit(1);
			const row = rows[0];
			if (!row) throw new Error("Coding bug: updated session not found");
			return row;
		},
		async deleteSession(sessionToken) {
			await db.delete(sessions).where(eq(sessions.sessionToken, sessionToken));
		},
		async createVerificationToken(verificationToken) {
			const normalizedIdentifier =
				verificationToken.identifier?.toLowerCase() ?? "";
			const existingTokens = await db
				.select()
				.from(verificationTokens)
				.where(eq(verificationTokens.identifier, normalizedIdentifier))
				.limit(1);

			if (existingTokens.length > 0) {
				await db
					.update(verificationTokens)
					.set({
						token: verificationToken.token,
						expires: verificationToken.expires,
					})
					.where(eq(verificationTokens.identifier, normalizedIdentifier));

				return await db
					.select()
					.from(verificationTokens)
					.where(eq(verificationTokens.identifier, normalizedIdentifier))
					.limit(1)
					.then((rows) => rows[0]);
			}

			await db.insert(verificationTokens).values({
				expires: verificationToken.expires,
				identifier: normalizedIdentifier,
				token: verificationToken.token,
			});

			const rows = await db
				.select()
				.from(verificationTokens)
				.where(eq(verificationTokens.token, verificationToken.token))
				.limit(1);
			const row = rows[0];
			if (!row) throw new Error("Error: inserted verification token not found");
			return row;
		},
		async useVerificationToken({ identifier, token }) {
			const rows = await db
				.select()
				.from(verificationTokens)
				.where(eq(verificationTokens.token, token))
				.limit(1);
			const row = rows[0];
			if (!row) {
				console.warn(
					"[useVerificationToken] No token found for hash",
					{ identifier, tokenPrefix: token.slice(0, 8) },
				);
				return null;
			}
			const normalizedIdentifier = identifier?.toLowerCase() ?? "";
			const storedIdentifier = row.identifier?.toLowerCase() ?? "";
			if (normalizedIdentifier !== storedIdentifier) {
				console.warn(
					"[useVerificationToken] Identifier mismatch",
					{ expected: normalizedIdentifier, stored: storedIdentifier },
				);
				return null;
			}
			await db
				.delete(verificationTokens)
				.where(
					and(
						eq(verificationTokens.token, token),
						eq(verificationTokens.identifier, row.identifier),
					),
				);
			return { ...row, identifier: storedIdentifier };
		},
	};
}
