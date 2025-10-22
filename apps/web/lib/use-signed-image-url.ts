import { skipToken } from "@tanstack/react-query";
import { Effect } from "effect";
import { useEffectQuery, useRpcClient } from "@/lib/EffectRuntime";

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
	const rpc = useRpcClient();

	return useEffectQuery({
		queryKey: ["signedImageUrl", key, type],
		queryFn: key
			? () => {
					if (!key) {
						return Effect.succeed(key);
					}

					return rpc.GetSignedImageUrl({ key, type }).pipe(
						Effect.map((result) => result.url),
						Effect.catchTag("InternalError", () => Effect.succeed(null)),
					);
				}
			: skipToken,
		enabled: !!key,
	});
}
