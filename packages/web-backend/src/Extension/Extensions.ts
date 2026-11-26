import { resolveOrCreateActiveOrganization } from "@cap/database/organization-pointer";
import * as Db from "@cap/database/schema";
import { userIsPro } from "@cap/utils";
import type { Organisation, User } from "@cap/web-domain";
import * as Dz from "drizzle-orm";
import { Data, Effect, Option } from "effect";

import { Database } from "../Database.ts";

// Auth keys are minted by a GET navigation, so a forced cross-site navigation
// could otherwise spam rows; cap how many keys one user can mint per window.
const AUTH_KEY_MINT_WINDOW_MS = 60 * 60 * 1000;
const AUTH_KEY_MINT_LIMIT = 10;

export class AuthKeyMintRateLimited extends Data.TaggedError(
	"AuthKeyMintRateLimited",
) {}

export class Extensions extends Effect.Service<Extensions>()("Extensions", {
	effect: Effect.gen(function* () {
		const db = yield* Database;

		return {
			isUserPro: Effect.fn("Extensions.isUserPro")(function* (
				userId: User.UserId,
			) {
				const [user] = yield* db.use((db) =>
					db
						.select({
							stripeSubscriptionStatus: Db.users.stripeSubscriptionStatus,
							thirdPartyStripeSubscriptionId:
								Db.users.thirdPartyStripeSubscriptionId,
						})
						.from(Db.users)
						.where(Dz.eq(Db.users.id, userId))
						.limit(1),
				);

				return userIsPro(user ?? null);
			}),

			mintAuthKey: Effect.fn("Extensions.mintAuthKey")(function* (
				userId: User.UserId,
			) {
				// Insert first, then count (including the new row) and roll back on
				// overflow. A check-then-insert would let concurrent mints race past
				// the limit; this way racers can transiently overshoot but every
				// overshooting mint deletes its own key and fails, so the table
				// settles at or below the cap.
				const authApiKey = crypto.randomUUID();
				yield* db.use((db) =>
					db.insert(Db.authApiKeys).values({
						id: authApiKey,
						userId,
						source: "extension",
					}),
				);

				const mintedSince = new Date(Date.now() - AUTH_KEY_MINT_WINDOW_MS);
				const recentKeys = yield* db.use((db) =>
					db
						.select({ id: Db.authApiKeys.id })
						.from(Db.authApiKeys)
						.where(
							Dz.and(
								Dz.eq(Db.authApiKeys.userId, userId),
								Dz.gt(Db.authApiKeys.createdAt, mintedSince),
							),
						)
						.limit(AUTH_KEY_MINT_LIMIT + 1),
				);

				if (recentKeys.length > AUTH_KEY_MINT_LIMIT) {
					yield* db.use((db) =>
						db
							.delete(Db.authApiKeys)
							.where(Dz.eq(Db.authApiKeys.id, authApiKey)),
					);
					return yield* Effect.fail(new AuthKeyMintRateLimited());
				}

				return authApiKey;
			}),

			revokeAuthKey: Effect.fn("Extensions.revokeAuthKey")(function* (
				userId: User.UserId,
				authApiKey: string,
			) {
				yield* db.use((db) =>
					db
						.delete(Db.authApiKeys)
						.where(
							Dz.and(
								Dz.eq(Db.authApiKeys.id, authApiKey),
								Dz.eq(Db.authApiKeys.userId, userId),
							),
						),
				);
			}),

			resolveBootstrapOrganization: Effect.fn(
				"Extensions.resolveBootstrapOrganization",
			)(function* (user: {
				id: User.UserId;
				activeOrganizationId: Organisation.OrganisationId;
			}) {
				// The extension records into whatever this returns and
				// createInstantRecording only accepts the stored active
				// organization, so a stale pointer is repaired, not returned,
				// and an account with no organization gets a personal one.
				const organization = yield* db.use((db) =>
					resolveOrCreateActiveOrganization(db, user),
				);

				return Option.fromNullable(organization);
			}),
		};
	}),
	dependencies: [Database.Default],
}) {}
