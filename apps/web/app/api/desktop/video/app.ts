import { dub } from "@/utils/dub";
import { getS3Bucket, getS3Config } from "@/utils/s3";
import { db } from "@cap/database";
import { sendEmail } from "@cap/database/emails/config";
import { FirstShareableLink } from "@cap/database/emails/first-shareable-link";
import { nanoId } from "@cap/database/helpers";
import { s3Buckets, videos } from "@cap/database/schema";
import { clientEnv, NODE_ENV } from "@cap/env";
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
      duration: z.number().optional(),
      recordingMode: z
        .union([z.literal("hls"), z.literal("desktopMP4")])
        .optional(),
      isScreenshot: z.coerce.boolean().default(false),
      videoId: z.string().optional(),
    })
  ),
  async (c) => {
    const { duration, recordingMode, isScreenshot, videoId } =
      c.req.valid("query");
    const user = c.get("user");

    // Check if user is on free plan and video is over 5 minutes
    const isUpgraded = user.stripeSubscriptionStatus === "active";

    if (!isUpgraded && duration && duration > 300)
      return c.json({ error: "upgrade_required" }, { status: 403 });

    const [bucket] = await db
      .select()
      .from(s3Buckets)
      .where(eq(s3Buckets.ownerId, user.id));

    const s3Config = await getS3Config(bucket);
    const bucketName = await getS3Bucket(bucket);

    const id = nanoId();
    const date = new Date();
    const formattedDate = `${date.getDate()} ${date.toLocaleString("default", {
      month: "long",
    })} ${date.getFullYear()}`;

    if (videoId !== undefined) {
      const [video] = await db
        .select()
        .from(videos)
        .where(eq(videos.id, videoId));

      if (!video) return c.json({ error: "video_not_found" }, { status: 404 });

      return c.json({
        id: video.id,
        user_id: user.id,
        aws_region: video.awsRegion,
        aws_bucket: video.awsBucket,
      });
    }

    const videoData = {
      id: id,
      name: `Cap ${
        isScreenshot ? "Screenshot" : "Recording"
      } - ${formattedDate}`,
      ownerId: user.id,
      awsRegion: s3Config.region,
      awsBucket: bucketName,
      source:
        recordingMode === "hls"
          ? { type: "local" as const }
          : recordingMode === "desktopMP4"
          ? { type: "desktopMP4" as const }
          : undefined,
      isScreenshot,
      bucket: bucket?.id,
    };

    await db.insert(videos).values(videoData);

    if (clientEnv.NEXT_PUBLIC_IS_CAP && NODE_ENV === "production")
      await dub.links.create({
        url: `${clientEnv.NEXT_PUBLIC_WEB_URL}/s/${id}`,
        domain: "cap.link",
        key: id,
      });

    // Check if this is the user's first video and send the first shareable link email
    try {
      const videoCount = await db
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

        const videoUrl = clientEnv.NEXT_PUBLIC_IS_CAP
          ? `https://cap.link/${id}`
          : `${clientEnv.NEXT_PUBLIC_WEB_URL}/s/${id}`;

        // Send email with 5-minute delay using Resend's scheduling feature
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
      console.error("Error checking for first video or sending email:", error);
    }

    return c.json({
      id,
      user_id: user.id,
      aws_region: s3Config.region,
      aws_bucket: bucketName,
    });
  }
);
