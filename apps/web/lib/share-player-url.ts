import { buildEnv } from "@cap/env";

export const getSharePlayerUrl = (videoId: string) =>
	new URL(`/embed/${videoId}`, buildEnv.NEXT_PUBLIC_WEB_URL).toString();
