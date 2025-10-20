import { Effect } from "effect";
import { useEffectQuery } from "@/lib/EffectRuntime";
import { withRpc } from "./Rpcs";

/**
 * Hook to get signed URL for an S3 image key
 * @param key - S3 key (starts with "users/" or "organizations/")
 * @returns Object with url, isLoading, error
 */
export function useSignedImageUrl(key: string | null | undefined) {
	return useEffectQuery({
		queryKey: ["signedImageUrl", key],
		queryFn: () => {
			if (
				!key ||
				(!key.startsWith("users/") && !key.startsWith("organizations/"))
			) {
				return Effect.succeed(key);
			}

			return withRpc((rpc) => rpc.GetSignedImageUrl({ key }))
				.pipe(Effect.map((result) => result.url))
				.pipe(Effect.catchTag("InternalError", () => Effect.succeed(null)));
		},
		enabled:
			!!key && (key.startsWith("users/") || key.startsWith("organizations/")),
	});
}
