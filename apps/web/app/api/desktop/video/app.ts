import { dub } from "@/utils/dub";
import { getS3Bucket, getS3Config } from "@/utils/s3";
import { db } from "@cap/database";
import { VideoMetadata } from "@cap/database/types";
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
      sourceName: z.string().optional(),
      recordingMode: z
        .union([z.literal("hls"), z.literal("desktopMP4")])
        .optional(),
      isScreenshot: z.coerce.boolean().default(false),
      videoId: z.string().optional(),
    })
  ),
  async (c) => {
    const { duration, recordingMode, isScreenshot, videoId, sourceName } =
      c.req.valid("query");
    const user = c.get("user");

    const isUpgraded = user.stripeSubscriptionStatus === "active";

    if (!isUpgraded && duration && duration > 300) {
      return c.json({ error: "upgrade_required" }, { status: 403 });
    }

    const [bucket] = await db()
      .select()
      .from(s3Buckets)
      .where(eq(s3Buckets.ownerId, user.id));

    const s3Config = await getS3Config(bucket);
    const bucketName = await getS3Bucket(bucket);

    const date = new Date();
    const formattedDate = `${date.getDate()} ${date.toLocaleString("default", {
      month: "long",
    })} ${date.getFullYear()}`;

    if (videoId !== undefined) {
      const [video] = await db()
        .select()
        .from(videos)
        .where(eq(videos.id, videoId));

      if (video) {
        const currentMetadata = (video.metadata as VideoMetadata) || {};
        const updatedMetadata: VideoMetadata = {
          ...currentMetadata,
          ...(sourceName ? { sourceName } : {}),
          ...(duration ? { duration } : {}),
        };

        if (sourceName || duration) {
          await db()
            .update(videos)
            .set({ metadata: updatedMetadata })
            .where(eq(videos.id, videoId));
        }

        return c.json({
          id: video.id,
          user_id: user.id,
          aws_region: video.awsRegion,
          aws_bucket: video.awsBucket,
        });
      }
    }

    const idToUse = videoId !== undefined ? videoId : nanoId();

    const videoData = {
      id: idToUse,
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
      metadata: {
        ...(sourceName ? { sourceName } : {}),
        ...(duration ? { duration } : {}),
      } as VideoMetadata,
    };

    await db().insert(videos).values(videoData);

    if (buildEnv.NEXT_PUBLIC_IS_CAP && NODE_ENV === "production") {
      await dub().links.create({
        url: `${serverEnv().WEB_URL}/s/${idToUse}`,
        domain: "cap.link",
        key: idToUse,
      });
    }

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
      }
    } catch (error) {}

    return c.json({
      id: idToUse,
      user_id: user.id,
      aws_region: s3Config.region,
      aws_bucket: bucketName,
    });
  }
);

app.post(
  "/metadata",
  zValidator(
    "json",
    z.object({
      videoId: z.string(),
      duration: z.coerce.number().optional(),
      sourceName: z.string().optional(),
      resolution: z.string().optional(),
      fps: z.coerce.number().optional(),
    })
  ),
  async (c) => {
    const { videoId, duration, sourceName, resolution, fps } = c.req.valid("json");
    const user = c.get("user");

    const [video] = await db().select().from(videos).where(eq(videos.id, videoId));

    if (!video || video.ownerId !== user.id) {
      return c.json({ error: "not_found" }, { status: 404 });
    }

    const currentMetadata = (video.metadata as VideoMetadata) || {};
    const updatedMetadata: VideoMetadata = {
      ...currentMetadata,
      ...(sourceName ? { sourceName } : {}),
      ...(duration ? { duration } : {}),
      ...(resolution ? { resolution } : {}),
      ...(fps ? { fps } : {}),
    };

    await db()
      .update(videos)
      .set({ metadata: updatedMetadata })
      .where(eq(videos.id, videoId));

    return c.json({ success: true });
  }
);
