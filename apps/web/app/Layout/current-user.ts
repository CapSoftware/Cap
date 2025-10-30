import { getCurrentUser } from "@cap/database/auth/session";
import { userIsPro } from "@cap/utils";
import { ImageUploads } from "@cap/web-backend";
import { Effect } from "effect";

export const resolveCurrentUser = Effect.gen(function* () {
	const imageUploads = yield* ImageUploads;

	return yield* Effect.promise(() => getCurrentUser()).pipe(
		Effect.flatMap(
			Effect.fn(function* (u) {
				if (!u) return null;
				return {
					id: u.id,
					name: u.name,
					lastName: u.lastName,
					defaultOrgId: u.defaultOrgId,
					email: u.email,
					imageUrl: u.image
						? yield* imageUploads.resolveImageUrl(u.image)
						: null,
					isPro: userIsPro(u),
				};
			}),
		),
	);
});
