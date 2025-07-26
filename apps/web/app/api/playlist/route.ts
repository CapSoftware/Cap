import { db } from "@cap/database";
import { s3Buckets, videos } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import {
  generateM3U8Playlist,
  generateMasterPlaylist,
} from "@/utils/video/ffmpeg/helpers";
import { CACHE_CONTROL_HEADERS } from "@/utils/helpers";
import { createBucketProvider } from "@/utils/s3";
import { serverEnv } from "@cap/env";
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import z from "zod";
import { handle } from "hono/vercel";

import { corsMiddleware, withOptionalAuth } from "../utils";
import { userHasAccessToVideo } from "@/utils/auth";

export const revalidate = "force-dynamic";

const app = new Hono()
  .basePath("/api/playlist")
  .use(corsMiddleware)
  .use(withOptionalAuth)
  .get(
    "/",
    zValidator(
      "query",
      z.object({
        videoId: z.string(),
        videoType: z
          .union([
            z.literal("video"),
            z.literal("audio"),
            z.literal("master"),
            z.literal("mp4"),
          ])
          .optional(),
        thumbnail: z.string().optional(),
        fileType: z.string().optional(),
      })
    ),
    async (c) => {
      const { videoId, videoType, thumbnail, fileType } = c.req.valid("query");
      const user = c.get("user");

      const query = await db()
        .select({ video: videos, bucket: s3Buckets })
        .from(videos)
        .leftJoin(s3Buckets, eq(videos.bucket, s3Buckets.id))
        .where(eq(videos.id, videoId));

      if (!query[0])
        return c.json(
          JSON.stringify({ error: true, message: "Video does not exist" }),
          404
        );

      const { video, bucket: customBucket } = query[0];

      const hasAccess = await userHasAccessToVideo(user, video);

      if (hasAccess === "private")
        return c.json(
          JSON.stringify({ error: true, message: "Video is not public" }),
          401
        );
      else if (hasAccess === "needs-password")
        return c.json(
          JSON.stringify({ error: true, message: "Video requires password" }),
          403
        );

      const bucket = await createBucketProvider(customBucket);

      if (!customBucket || video.awsBucket === serverEnv().CAP_AWS_BUCKET) {
        if (video.source.type === "desktopMP4") {
          return c.redirect(
            await bucket.getSignedObjectUrl(
              `${video.ownerId}/${videoId}/result.mp4`
            )
          );
        }

        if (video.source.type === "MediaConvert") {
          return c.redirect(
            await bucket.getSignedObjectUrl(
              `${video.ownerId}/${videoId}/output/video_recording_000.m3u8`
            )
          );
        }

        return c.redirect(
          await bucket.getSignedObjectUrl(
            `${video.ownerId}/${videoId}/combined-source/stream.m3u8`
          )
        );
      }

      if (fileType === "transcription") {
        try {
          const transcriptionContent = await bucket.getObject(
            `${video.ownerId}/${videoId}/transcription.vtt`
          );

          return c.body(transcriptionContent ?? "", {
            headers: {
              ...CACHE_CONTROL_HEADERS,
              "Content-Type": "text/vtt",
            },
          });
        } catch (error) {
          console.error("Error fetching transcription file:", error);
          return c.json(
            {
              error: true,
              message: "Transcription file not found",
            },
            404
          );
        }
      }

      const videoPrefix = `${video.ownerId}/${videoId}/video/`;
      const audioPrefix = `${video.ownerId}/${videoId}/audio/`;

      try {
        if (video.source.type === "local") {
          const playlistText =
            (await bucket.getObject(
              `${video.ownerId}/${videoId}/combined-source/stream.m3u8`
            )) ?? "";

          const lines = playlistText.split("\n");

          for (const [index, line] of lines.entries()) {
            if (line.endsWith(".ts")) {
              const url = await bucket.getObject(
                `${video.ownerId}/${videoId}/combined-source/${line}`
              );
              if (!url) continue;
              lines[index] = url;
            }
          }

          const playlist = lines.join("\n");

          return c.text(playlist, {
            headers: CACHE_CONTROL_HEADERS,
          });
        }

        if (video.source.type === "desktopMP4") {
          const playlistUrl = await bucket.getSignedObjectUrl(
            `${video.ownerId}/${videoId}/result.mp4`
          );
          if (!playlistUrl) return new Response(null, { status: 404 });

          return c.redirect(playlistUrl);
        }

        let prefix;
        switch (videoType) {
          case "video":
            prefix = videoPrefix;
            break;
          case "audio":
            prefix = audioPrefix;
            break;
          case "master":
            prefix = null;
            break;
          default:
            return c.json({ error: true, message: "Invalid video type" }, 401);
        }

        if (prefix === null) {
          const [videoSegment, audioSegment] = await Promise.all([
            bucket.listObjects({ prefix: videoPrefix, maxKeys: 1 }),
            bucket.listObjects({ prefix: audioPrefix, maxKeys: 1 }),
          ]);

          let audioMetadata;
          const videoMetadata = await bucket.headObject(
            videoSegment.Contents?.[0]?.Key ?? ""
          );
          if (audioSegment?.KeyCount && audioSegment?.KeyCount > 0) {
            audioMetadata = await bucket.headObject(
              audioSegment.Contents?.[0]?.Key ?? ""
            );
          }

          const generatedPlaylist = await generateMasterPlaylist(
            videoMetadata?.Metadata?.resolution ?? "",
            videoMetadata?.Metadata?.bandwidth ?? "",
            `${serverEnv().WEB_URL}/api/playlist?userId=${
              video.ownerId
            }&videoId=${videoId}&videoType=video`,
            audioMetadata
              ? `${serverEnv().WEB_URL}/api/playlist?userId=${
                  video.ownerId
                }&videoId=${videoId}&videoType=audio`
              : null,
            video.xStreamInfo ?? ""
          );

          return c.text(generatedPlaylist, {
            headers: CACHE_CONTROL_HEADERS,
          });
        }

        const objects = await bucket.listObjects({
          prefix,
          maxKeys: thumbnail ? 1 : undefined,
        });

        const chunksUrls = await Promise.all(
          (objects.Contents || []).map(async (object) => {
            const url = await bucket.getSignedObjectUrl(object.Key ?? "");
            const metadata = await bucket.headObject(object.Key ?? "");

            return {
              url: url,
              duration: metadata?.Metadata?.duration ?? "",
              bandwidth: metadata?.Metadata?.bandwidth ?? "",
              resolution: metadata?.Metadata?.resolution ?? "",
              videoCodec: metadata?.Metadata?.videocodec ?? "",
              audioCodec: metadata?.Metadata?.audiocodec ?? "",
            };
          })
        );

        const generatedPlaylist = generateM3U8Playlist(chunksUrls);

        return c.text(generatedPlaylist, {
          headers: CACHE_CONTROL_HEADERS,
        });
      } catch (error) {
        console.error("Error generating video segment URLs", error);
        return c.json(
          {
            error: error,
            message: "Error generating video URLs",
          },
          500
        );
      }
    }
  );

export const GET = handle(app);
export const OPTIONS = handle(app);
export const HEAD = handle(app);
