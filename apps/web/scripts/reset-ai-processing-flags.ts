import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { sql } from "drizzle-orm";

async function resetStuckAiProcessingFlags() {
	console.log("Checking for stuck AI processing flags...");

	const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);

	const stuckVideos = await db()
		.select()
		.from(videos)
		.where(sql`
      (metadata->>'aiProcessing')::boolean = true
      AND updated_at < ${tenMinutesAgo}
    `);

	console.log(
		`Found ${stuckVideos.length} videos with stuck AI processing flags`,
	);

	for (const video of stuckVideos) {
		const metadata = (video.metadata as VideoMetadata) || {};
		console.log(
			`Resetting AI processing flag for video ${video.id} (updated ${video.updatedAt})`,
		);

		await db()
			.update(videos)
			.set({
				metadata: {
					...metadata,
					aiProcessing: false,
					// generationError: "AI processing was stuck and has been reset",
				},
			})
			.where(sql`id = ${video.id}`);
	}

	console.log("Done resetting stuck AI processing flags");
	process.exit(0);
}

resetStuckAiProcessingFlags().catch((error) => {
	console.error("Error resetting AI processing flags:", error);
	process.exit(1);
});
