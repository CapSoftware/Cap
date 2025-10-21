import { Effect } from "effect";
import { useEffectQuery } from "@/lib/EffectRuntime";
import { withRpc } from "./Rpcs";

/**
 * Hook to get signed URL for an S3 image key
 * @param key - S3 key
 * @param type - Type of image ("user" or "organization")
 * @returns Object with url, isLoading, error
 */
export function useSignedImageUrl(
	key: string | null | undefined,
	type: "user" | "organization",
) {
	return useEffectQuery({
		queryKey: ["signedImageUrl", key, type],
		queryFn: () => {
			if (!key) {
				return Effect.succeed(key);
			}

			return withRpc((rpc) => rpc.GetSignedImageUrl({ key, type }))
				.pipe(Effect.map((result) => result.url))
				.pipe(Effect.catchTag("InternalError", () => Effect.succeed(null)));
		},
		enabled: !!key,
	});
}
