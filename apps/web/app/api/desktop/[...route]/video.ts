import { dub } from "@/utils/dub";
import { createBucketProvider } from "@/utils/s3";
import { db } from "@cap/database";
import { sendEmail } from "@cap/database/emails/config";
import { FirstShareableLink } from "@cap/database/emails/first-shareable-link";
import { nanoId } from "@cap/database/helpers";
import { s3Buckets, videos } from "@cap/database/schema";
import { buildEnv, NODE_ENV, serverEnv } from "@cap/env";
import { zValidator } from "@hono/zod-validator";
import { count, eq, and } from "drizzle-orm";
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

      const idToUse = nanoId();

      const videoName =
        name ??
        `Cap ${isScreenshot ? "Screenshot" : "Recording"} - ${formattedDate}`;

      await db()
        .insert(videos)
        .values({
          id: idToUse,
          name: videoName,
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
          public: serverEnv().CAP_VIDEOS_DEFAULT_PUBLIC,
          metadata: {
            duration,
          },
        });

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

app.delete(
  "/delete",
  zValidator("query", z.object({ videoId: z.string() })),
  async (c) => {
    const { videoId } = c.req.valid("query");
    const user = c.get("user");

    try {
      const [result] = await db()
        .select({ video: videos, bucket: s3Buckets })
        .from(videos)
        .leftJoin(s3Buckets, eq(videos.bucket, s3Buckets.id))
        .where(eq(videos.id, videoId));

      if (!result)
        return c.json(
          { error: true, message: "Video not found" },
          { status: 404 }
        );

      await db()
        .delete(videos)
        .where(and(eq(videos.id, videoId), eq(videos.ownerId, user.id)));

      const bucket = await createBucketProvider(result.bucket);

      const listedObjects = await bucket.listObjects({
        prefix: `${user.id}/${videoId}/`,
      });

      if (listedObjects.Contents?.length)
        await bucket.deleteObjects(
          listedObjects.Contents.map((content: any) => ({
            Key: content.Key,
          }))
        );

      return c.json(true);
    } catch (error) {
      console.error("Error in video delete endpoint:", error);
      return c.json({ error: "Internal server error" }, { status: 500 });
    }
  }
);
