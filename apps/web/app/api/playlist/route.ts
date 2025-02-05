import { type NextRequest } from "next/server";
import { db } from "@cap/database";
import { s3Buckets, videos } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import {
  ListObjectsV2Command,
  GetObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getCurrentUser } from "@cap/database/auth/session";
import {
  generateM3U8Playlist,
  generateMasterPlaylist,
} from "@/utils/video/ffmpeg/helpers";
import { getHeaders, CACHE_CONTROL_HEADERS } from "@/utils/helpers";
import { createS3Client, getS3Bucket } from "@/utils/s3";
import { S3_BUCKET_URL } from "@cap/utils";
import { clientEnv } from "@cap/env";

export const revalidate = 3599;

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

  const query = await db
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

  const { video, bucket } = query[0];

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

  const Bucket = await getS3Bucket(bucket);
  const s3Client = await createS3Client(bucket);

  if (!bucket || video.awsBucket === clientEnv.NEXT_PUBLIC_CAP_AWS_BUCKET) {
    if (video.source.type === "desktopMP4") {
      return new Response(null, {
        status: 302,
        headers: {
          ...getHeaders(origin),
          Location: `${S3_BUCKET_URL}/${userId}/${videoId}/result.mp4`,
          ...CACHE_CONTROL_HEADERS,
        },
      });
    }

    if (video.source.type === "MediaConvert") {
      return new Response(null, {
        status: 302,
        headers: {
          ...getHeaders(origin),
          Location: `${S3_BUCKET_URL}/${userId}/${videoId}/output/video_recording_000.m3u8`,
          ...CACHE_CONTROL_HEADERS,
        },
      });
    }

    const playlistUrl = `${S3_BUCKET_URL}/${userId}/${videoId}/combined-source/stream.m3u8`;
    return new Response(null, {
      status: 302,
      headers: {
        ...getHeaders(origin),
        Location: playlistUrl,
        ...CACHE_CONTROL_HEADERS,
      },
    });
  }

  // Handle transcription file request first
  if (fileType === "transcription") {
    try {
      const transcriptionUrl = await getSignedUrl(
        s3Client,
        new GetObjectCommand({
          Bucket,
          Key: `${userId}/${videoId}/transcription.vtt`,
        }),
        { expiresIn: 3600 }
      );

      const response = await fetch(transcriptionUrl);
      const transcriptionContent = await response.text();

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
      const playlistUrl = await getSignedUrl(
        s3Client,
        new GetObjectCommand({
          Bucket,
          Key: `${userId}/${videoId}/combined-source/stream.m3u8`,
        }),
        { expiresIn: 3600 }
      );
      const playlistResp = await fetch(playlistUrl);
      const playlistText = await playlistResp.text();

      const lines = playlistText.split("\n");

      for (const [index, line] of lines.entries()) {
        if (line.endsWith(".ts")) {
          lines[index] = await getSignedUrl(
            s3Client,
            new GetObjectCommand({
              Bucket,
              Key: `${userId}/${videoId}/combined-source/${line}`,
            }),
            { expiresIn: 3600 }
          );
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
      const playlistUrl = await getSignedUrl(
        s3Client,
        new GetObjectCommand({
          Bucket,
          Key: `${userId}/${videoId}/result.mp4`,
        }),
        { expiresIn: 3600 }
      );

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
    let objectsCommand, prefix;
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
      const videoSegmentCommand = new ListObjectsV2Command({
        Bucket,
        Prefix: videoPrefix,
        MaxKeys: 1,
      });

      let audioSegment;
      const audioSegmentCommand = new ListObjectsV2Command({
        Bucket,
        Prefix: audioPrefix,
        MaxKeys: 1,
      });

      try {
        audioSegment = await s3Client.send(audioSegmentCommand);
      } catch (error) {
        console.warn("No audio segment found for this video", error);
      }

      const [videoSegment] = await Promise.all([
        s3Client.send(videoSegmentCommand),
      ]);

      let audioMetadata;
      const [videoMetadata] = await Promise.all([
        s3Client.send(
          new HeadObjectCommand({
            Bucket,
            Key: videoSegment.Contents?.[0]?.Key ?? "",
          })
        ),
      ]);

      if (audioSegment?.KeyCount && audioSegment?.KeyCount > 0) {
        audioMetadata = await s3Client.send(
          new HeadObjectCommand({
            Bucket,
            Key: audioSegment.Contents?.[0]?.Key ?? "",
          })
        );
      }

      const generatedPlaylist = await generateMasterPlaylist(
        videoMetadata?.Metadata?.resolution ?? "",
        videoMetadata?.Metadata?.bandwidth ?? "",
        `${clientEnv.NEXT_PUBLIC_WEB_URL}/api/playlist?userId=${userId}&videoId=${videoId}&videoType=video`,
        audioMetadata
          ? `${clientEnv.NEXT_PUBLIC_WEB_URL}/api/playlist?userId=${userId}&videoId=${videoId}&videoType=audio`
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

    objectsCommand = new ListObjectsV2Command({
      Bucket,
      Prefix: prefix,
      MaxKeys: thumbnail ? 1 : undefined,
    });

    const objects = await s3Client.send(objectsCommand);

    const chunksUrls = await Promise.all(
      (objects.Contents || []).map(async (object) => {
        const url = await getSignedUrl(
          s3Client,
          new GetObjectCommand({ Bucket, Key: object.Key }),
          { expiresIn: 3600 }
        );
        const metadata = await s3Client.send(
          new HeadObjectCommand({ Bucket, Key: object.Key })
        );

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
