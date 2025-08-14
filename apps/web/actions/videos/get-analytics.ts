"use server";

import { dub } from "@/utils/dub";

export async function getVideoAnalytics(videoId: string) {
	if (!videoId) {
		throw new Error("Video ID is required");
	}

	try {
		const response = await dub().analytics.retrieve({
			domain: "cap.link",
			key: videoId,
		});
		const { clicks } = response as { clicks: number };

		if (typeof clicks !== "number" || clicks === null) {
			return { count: 0 };
		}

		return { count: clicks };
	} catch (error: any) {
		if (error.code === "not_found") {
			return { count: 0 };
		}
		return { count: 0 };
	}
}
