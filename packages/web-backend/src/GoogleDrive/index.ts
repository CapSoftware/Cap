import { decrypt, encrypt } from "@cap/database/crypto";
import type { GoogleDrive, User } from "@cap/web-domain";
import { Config, Effect, Option } from "effect";

import { Database } from "../Database.ts";
import { createGoogleDriveAccess } from "./GoogleDriveAccess.ts";
import { GoogleDriveConfigsRepo } from "./GoogleDriveConfigsRepo.ts";

export {
	createGoogleDriveAccess,
	type GoogleDriveAccess,
	type GoogleDriveUploadResult,
} from "./GoogleDriveAccess.ts";
export { GoogleDriveConfigsRepo } from "./GoogleDriveConfigsRepo.ts";

export class GoogleDriveService extends Effect.Service<GoogleDriveService>()(
	"GoogleDriveService",
	{
		effect: Effect.gen(function* () {
			const repo = yield* GoogleDriveConfigsRepo;

			const clientId = yield* Config.string("GOOGLE_CLIENT_ID").pipe(
				Config.orElse(() => Config.succeed("")),
			);
			const clientSecret = yield* Config.string("GOOGLE_CLIENT_SECRET").pipe(
				Config.orElse(() => Config.succeed("")),
			);

			const getAccessForConfig = Effect.fn(
				"GoogleDriveService.getAccessForConfig",
			)(function* (config: GoogleDrive.GoogleDriveConfig) {
				const accessToken = yield* Effect.promise(() =>
					decrypt(config.accessToken),
				);
				const refreshToken = yield* Effect.promise(() =>
					decrypt(config.refreshToken),
				);

				return yield* createGoogleDriveAccess({
					clientId,
					clientSecret,
					accessToken,
					refreshToken,
					expiresAt: config.expiresAt,
					configId: config.id,
				});
			});

			const getAccessForUser = Effect.fn("GoogleDriveService.getAccessForUser")(
				function* (userId: User.UserId) {
					const configOption = yield* repo.getForUser(userId);
					if (Option.isNone(configOption)) {
						return Option.none<
							Effect.Effect.Success<ReturnType<typeof createGoogleDriveAccess>>
						>();
					}
					const access = yield* getAccessForConfig(configOption.value);
					return Option.some(access);
				},
			);

			const getAccessById = Effect.fn("GoogleDriveService.getAccessById")(
				function* (configId: GoogleDrive.GoogleDriveConfigId) {
					const configOption = yield* repo.getById(configId);
					if (Option.isNone(configOption)) {
						return Option.none<
							Effect.Effect.Success<ReturnType<typeof createGoogleDriveAccess>>
						>();
					}
					const access = yield* getAccessForConfig(configOption.value);
					return Option.some(access);
				},
			);

			return {
				repo,
				clientId,
				clientSecret,
				getAccessForUser,
				getAccessById,
				getAccessForConfig,
			};
		}),
		dependencies: [GoogleDriveConfigsRepo.Default, Database.Default],
	},
) {
	static getAccessForUser = (userId: User.UserId) =>
		Effect.flatMap(GoogleDriveService, (s) => s.getAccessForUser(userId));

	static getAccessById = (configId: GoogleDrive.GoogleDriveConfigId) =>
		Effect.flatMap(GoogleDriveService, (s) => s.getAccessById(configId));
}
