import { InternalError } from "@cap/web-domain";
import { Effect, Option } from "effect";
import * as path from "path";

export const parseImageKey = (
	imageKey: string | null | undefined,
	expectedType: "user" | "organization",
): Effect.Effect<Option.Option<string>, InternalError> =>
	Effect.gen(function* () {
		// Return None if no image key provided
		if (!imageKey || imageKey.trim() === "") {
			return Option.none();
		}

		let s3Key = imageKey;
		if (imageKey.startsWith("http://") || imageKey.startsWith("https://")) {
			const url = new URL(imageKey);
			const raw = url.pathname.startsWith("/")
				? url.pathname.slice(1)
				: url.pathname;
			const decoded = decodeURIComponent(raw);
			const normalized = path.posix.normalize(decoded);
			if (normalized.includes("..")) {
				return yield* Effect.fail(new InternalError({ type: "unknown" }));
			}
			s3Key = normalized;
		}

		const expectedPrefix =
			expectedType === "user" ? "users/" : "organizations/";
		if (!s3Key.startsWith(expectedPrefix)) {
			return Option.none();
		}

		return Option.some(s3Key);
	});
