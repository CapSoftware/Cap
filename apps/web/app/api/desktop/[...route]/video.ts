import { dub } from "@/utils/dub";
import { createBucketProvider, getS3Bucket, getS3Config } from "@/utils/s3";
import { db } from "@cap/database";
import { sendEmail } from "@cap/database/emails/config";
import { FirstShareableLink } from "@cap/database/emails/first-shareable-link";
import { nanoId } from "@cap/database/helpers";
import { s3Buckets, videos } from "@cap/database/schema";
import { buildEnv, NODE_ENV, serverEnv } from "@cap/env";
import { zValidator } from "@hono/zod-validator";
import { count, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { withAuth } from "../../utils";

export const app = new Hono().use(withAuth);

app.get(
  "/create",
  zValidator(
    "query",
    z.object({
      duration: z.coerce.number().optional(),
      recordingMode: z
        .union([z.literal("hls"), z.literal("desktopMP4")])
        .optional(),
      isScreenshot: z.coerce.boolean().default(false),
      videoId: z.string().optional(),
      name: z.string().optional(),
    })
  ),
  async (c) => {
    try {
      const { duration, recordingMode, isScreenshot, videoId, name } =
        c.req.valid("query");
      const user = c.get("user");

      console.log("Video create request:", {
        duration,
        recordingMode,
        isScreenshot,
        videoId,
        userId: user.id,
      });

      const isUpgraded = user.stripeSubscriptionStatus === "active";

      if (!isUpgraded && duration && duration > 300)
        return c.json({ error: "upgrade_required" }, { status: 403 });

      const [customBucket] = await db()
        .select()
        .from(s3Buckets)
        .where(eq(s3Buckets.ownerId, user.id));

      console.log("User bucket:", customBucket ? "found" : "not found");

      const bucket = await createBucketProvider(customBucket);

      const date = new Date();
      const formattedDate = `${date.getDate()} ${date.toLocaleString(
        "default",
        { month: "long" }
      )} ${date.getFullYear()}`;

      if (videoId !== undefined) {
        const [video] = await db()
          .select()
          .from(videos)
          .where(eq(videos.id, videoId));

        if (video) {
          return c.json({
            id: video.id,
            // All deprecated
            user_id: user.id,
            aws_region: "n/a",
            aws_bucket: "n/a",
          });
        }
      }

      const idToUse = videoId !== undefined ? videoId : nanoId();

      const videoData = {
        id: idToUse,
        name:
          name ??
          `Cap ${isScreenshot ? "Screenshot" : "Recording"} - ${formattedDate}`,
        ownerId: user.id,
        awsRegion: "auto",
        awsBucket: bucket.name,
        source:
          recordingMode === "hls"
            ? { type: "local" as const }
            : recordingMode === "desktopMP4"
            ? { type: "desktopMP4" as const }
            : undefined,
        isScreenshot,
        bucket: customBucket?.id,
      };

      await db().insert(videos).values(videoData);

      if (buildEnv.NEXT_PUBLIC_IS_CAP && NODE_ENV === "production")
        await dub().links.create({
          url: `${serverEnv().WEB_URL}/s/${idToUse}`,
          domain: "cap.link",
          key: idToUse,
        });

      try {
        const videoCount = await db()
          .select({ count: count() })
          .from(videos)
          .where(eq(videos.ownerId, user.id));

        if (
          videoCount &&
          videoCount[0] &&
          videoCount[0].count === 1 &&
          user.email
        ) {
          console.log(
            "[SendFirstShareableLinkEmail] Sending first shareable link email with 5-minute delay"
          );

          const videoUrl = buildEnv.NEXT_PUBLIC_IS_CAP
            ? `https://cap.link/${idToUse}`
            : `${serverEnv().WEB_URL}/s/${idToUse}`;

          await sendEmail({
            email: user.email,
            subject: "You created your first Cap! 🥳",
            react: FirstShareableLink({
              email: user.email,
              url: videoUrl,
              videoName: videoData.name,
            }),
            marketing: true,
            scheduledAt: "in 5 min",
          });

          console.log(
            "[SendFirstShareableLinkEmail] First shareable link email scheduled to be sent in 5 minutes"
          );
        }
      } catch (error) {
        console.error(
          "Error checking for first video or sending email:",
          error
        );
      }

      return c.json({
        id: idToUse,
        // All deprecated
        user_id: user.id,
        aws_region: "n/a",
        aws_bucket: "n/a",
      });
    } catch (error) {
      console.error("Error in video create endpoint:", error);
      return c.json({ error: "Internal server error" }, { status: 500 });
    }
  }
);
