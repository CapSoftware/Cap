import { STRIPE_AVAILABLE, stripe } from "@cap/utils";
import { and, eq } from "drizzle-orm";
import type { PlanetScaleDatabase } from "drizzle-orm/planetscale-serverless";
import type { Adapter } from "next-auth/adapters";
import { nanoId } from "../helpers";
import { accounts, sessions, users, verificationTokens } from "../schema";

export function DrizzleAdapter(db: PlanetScaleDatabase): Adapter {
	return {
		async createUser(userData: any) {
			await db.insert(users).values({
				id: nanoId(),
				email: userData.email,
				emailVerified: userData.emailVerified,
				name: userData.name,
				image: userData.image,
				activeOrganizationId: "",
			});
			const rows = await db
				.select()
				.from(users)
				.where(eq(users.email, userData.email))
				.limit(1);
			const row = rows[0];
			if (!row) throw new Error("User not found");

			if (STRIPE_AVAILABLE()) {
				const customer = await stripe().customers.create({
					email: userData.email,
					metadata: {
						userId: nanoId(),
					},
				});

				await db
					.update(users)
					.set({
						stripeCustomerId: customer.id,
					})
					.where(eq(users.id, row.id));
			}

			return row;
		},
		async getUser(id) {
			const rows = await db
				.select()
				.from(users)
				.where(eq(users.id, id))
				.limit(1);
			const row = rows[0];
			return row ?? null;
		},
		async getUserByEmail(email) {
			const rows = await db
				.select()
				.from(users)
				.where(eq(users.email, email))
				.limit(1)
				.catch((e) => {
					console.log(e);
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
						eq(accounts.provider, provider)
					)
				)
				.limit(1);
			const row = rows[0];
			return row?.users ?? null;
		},
		async updateUser({ id, ...userData }) {
			if (!id) throw new Error("User not found");
			await db.update(users).set(userData).where(eq(users.id, id));
			const rows = await db
				.select()
				.from(users)
				.where(eq(users.id, id))
				.limit(1);
			const row = rows[0];
			if (!row) throw new Error("User not found");
			return row;
		},
		async deleteUser(userId) {
			await db.delete(users).where(eq(users.id, userId));
		},
		async linkAccount(account: any) {
			await db.insert(accounts).values({
				id: nanoId(),
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
						eq(accounts.provider, provider)
					)
				);
		},
		async createSession(data) {
			await db.insert(sessions).values({
				id: nanoId(),
				expires: data.expires,
				sessionToken: data.sessionToken,
				userId: data.userId,
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
					userId: session.userId,
					sessionToken: session.sessionToken,
					expires: session.expires,
				},
			};
		},
		async updateSession(session) {
			await db
				.update(sessions)
				.set(session)
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
			// First, check if a token for the given identifier already exists
			const existingTokens = await db
				.select()
				.from(verificationTokens)
				.where(eq(verificationTokens.identifier, verificationToken.identifier))
				.limit(1);

			// If a token already exists, you can return the existing token
			// or handle it based on your business logic
			if (existingTokens.length > 0) {
				// For example, updating the existing token:
				await db
					.update(verificationTokens)
					.set({
						token: verificationToken.token,
						expires: verificationToken.expires,
						// you may update other fields as necessary
					})
					.where(
						eq(verificationTokens.identifier, verificationToken.identifier)
					);

				// Return the updated token
				return await db
					.select()
					.from(verificationTokens)
					.where(
						eq(verificationTokens.identifier, verificationToken.identifier)
					)
					.limit(1)
					.then((rows) => rows[0]);
			}

			// If the token does not exist, proceed to create a new one
			await db.insert(verificationTokens).values({
				expires: verificationToken.expires,
				identifier: verificationToken.identifier,
				token: verificationToken.token,
			});

			// Retrieve and return the newly created token
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
			if (!row) return null;
			await db
				.delete(verificationTokens)
				.where(
					and(
						eq(verificationTokens.token, token),
						eq(verificationTokens.identifier, identifier)
					)
				);
			return row;
		},
	};
}
