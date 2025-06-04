import { type NextRequest } from "next/server";
import { db } from "@cap/database";
import { s3Buckets, videos } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import { getCurrentUser } from "@cap/database/auth/session";
import {
  generateM3U8Playlist,
  generateMasterPlaylist,
} from "@/utils/video/ffmpeg/helpers";
import { getHeaders, CACHE_CONTROL_HEADERS } from "@/utils/helpers";
import { createBucketProvider } from "@/utils/s3";
import { serverEnv } from "@cap/env";

export const revalidate = 60;

export async function OPTIONS(request: NextRequest) {
  const origin = request.headers.get("origin") as string;

  return new Response(null, {
    status: 200,
    headers: getHeaders(origin),
  });
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const userId = searchParams.get("userId") || "";
  const videoId = searchParams.get("videoId") || "";
  const videoType = searchParams.get("videoType") || "";
  const thumbnail = searchParams.get("thumbnail") || "";
  const fileType = searchParams.get("fileType") || "";
  const origin = request.headers.get("origin") as string;

  if (!userId || !videoId) {
    return new Response(
      JSON.stringify({
        error: true,
        message: "userId or videoId not supplied",
      }),
      { status: 401, headers: getHeaders(origin) }
    );
  }

  const query = await db()
    .select({ video: videos, bucket: s3Buckets })
    .from(videos)
    .leftJoin(s3Buckets, eq(videos.bucket, s3Buckets.id))
    .where(eq(videos.id, videoId));

  if (!query[0]) {
    return new Response(
      JSON.stringify({ error: true, message: "Video does not exist" }),
      {
        status: 401,
        headers: getHeaders(origin),
      }
    );
  }

  const { video, bucket: customBucket } = query[0];

  if (video.public === false) {
    const user = await getCurrentUser();

    if (!user || user.id !== video.ownerId) {
      return new Response(
        JSON.stringify({ error: true, message: "Video is not public" }),
        {
          status: 401,
          headers: getHeaders(origin),
        }
      );
    }
  }

  const bucket = await createBucketProvider(customBucket);

  if (!customBucket || video.awsBucket === serverEnv().CAP_AWS_BUCKET) {
    if (video.source.type === "desktopMP4") {
      return new Response(null, {
        status: 302,
        headers: {
          ...getHeaders(origin),
          Location: await bucket.getSignedObjectUrl(
            `${userId}/${videoId}/result.mp4`
          ),
          ...CACHE_CONTROL_HEADERS,
        },
      });
    }

    if (video.source.type === "MediaConvert") {
      return new Response(null, {
        status: 302,
        headers: {
          ...getHeaders(origin),
          Location: await bucket.getSignedObjectUrl(
            `${userId}/${videoId}/output/video_recording_000.m3u8`
          ),
          ...CACHE_CONTROL_HEADERS,
        },
      });
    }

    return new Response(null, {
      status: 302,
      headers: {
        ...getHeaders(origin),
        Location: await bucket.getSignedObjectUrl(
          `${userId}/${videoId}/combined-source/stream.m3u8`
        ),
        ...CACHE_CONTROL_HEADERS,
      },
    });
  }

  // Handle transcription file request first
  if (fileType === "transcription") {
    try {
      const transcriptionContent = await bucket.getObject(
        `${userId}/${videoId}/transcription.vtt`
      );

      return new Response(transcriptionContent, {
        status: 200,
        headers: {
          ...getHeaders(origin),
          ...CACHE_CONTROL_HEADERS,
          "Content-Type": "text/vtt",
        },
      });
    } catch (error) {
      console.error("Error fetching transcription file:", error);
      return new Response(
        JSON.stringify({
          error: true,
          message: "Transcription file not found",
        }),
        {
          status: 404,
          headers: getHeaders(origin),
        }
      );
    }
  }

  // Handle video/audio files
  const videoPrefix = `${userId}/${videoId}/video/`;
  const audioPrefix = `${userId}/${videoId}/audio/`;

  try {
    if (video.source.type === "local") {
      const playlistText =
        (await bucket.getObject(
          `${userId}/${videoId}/combined-source/stream.m3u8`
        )) ?? "";

      const lines = playlistText.split("\n");

      for (const [index, line] of lines.entries()) {
        if (line.endsWith(".ts")) {
          const url = await bucket.getObject(
            `${userId}/${videoId}/combined-source/${line}`
          );
          if (!url) continue;
          lines[index] = url;
        }
      }

      const playlist = lines.join("\n");

      return new Response(playlist, {
        status: 200,
        headers: {
          ...getHeaders(origin),
          ...CACHE_CONTROL_HEADERS,
        },
      });
    }

    if (video.source.type === "desktopMP4") {
      const playlistUrl = await bucket.getObject(
        `${userId}/${videoId}/result.mp4`
      );
      if (!playlistUrl) return new Response(null, { status: 404 });

      console.log(`Got signed url for desktop: ${playlistUrl}`);

      return new Response(null, {
        status: 302,
        headers: {
          ...getHeaders(origin),
          Location: playlistUrl,
          ...CACHE_CONTROL_HEADERS,
        },
      });
    }

    // Handle screen, video, and now audio types
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
        return new Response(
          JSON.stringify({ error: true, message: "Invalid video type" }),
          { status: 401, headers: getHeaders(origin) }
        );
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
        `${
          serverEnv().WEB_URL
        }/api/playlist?userId=${userId}&videoId=${videoId}&videoType=video`,
        audioMetadata
          ? `${
              serverEnv().WEB_URL
            }/api/playlist?userId=${userId}&videoId=${videoId}&videoType=audio`
          : null,
        video.xStreamInfo ?? ""
      );

      return new Response(generatedPlaylist, {
        status: 200,
        headers: {
          ...getHeaders(origin),
          ...CACHE_CONTROL_HEADERS,
        },
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

    return new Response(generatedPlaylist, {
      status: 200,
      headers: {
        ...getHeaders(origin),
        ...CACHE_CONTROL_HEADERS,
      },
    });
  } catch (error) {
    console.error("Error generating video segment URLs", error);
    return new Response(
      JSON.stringify({ error: error, message: "Error generating video URLs" }),
      {
        status: 500,
        headers: getHeaders(origin),
      }
    );
  }
}
