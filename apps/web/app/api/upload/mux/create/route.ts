import { type NextRequest } from "next/server";
import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";
import {
  MediaConvertClient,
  CreateJobCommand,
} from "@aws-sdk/client-mediaconvert";
const allowedOrigins = [
  process.env.NEXT_PUBLIC_URL,
  "http://localhost:3001",
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
  "https://cap.link",
  "https://cap.so",
];

export async function OPTIONS(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const origin = params.get("origin") || null;
  const originalOrigin = req.nextUrl.origin;

  return new Response(null, {
    status: 200,
    headers: {
      "Access-Control-Allow-Origin":
        origin && allowedOrigins.includes(origin)
          ? origin
          : allowedOrigins.includes(originalOrigin)
          ? originalOrigin
          : "null",
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, sentry-trace, baggage",
    },
  });
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const videoId = searchParams.get("videoId") || "";
  const userId = searchParams.get("userId") || "";
  const origin = request.headers.get("origin") as string;

  if (!videoId || !userId) {
    return new Response(
      JSON.stringify({
        error: true,
        message: "videoId not supplied or user not logged in",
      }),
      {
        status: 401,
        headers: {
          "Access-Control-Allow-Origin": allowedOrigins.includes(origin)
            ? origin
            : "null",
          "Access-Control-Allow-Credentials": "true",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
        },
      }
    );
  }

  const query = await db.select().from(videos).where(eq(videos.id, videoId));

  if (query.length === 0) {
    return new Response(
      JSON.stringify({ error: true, message: "Video does not exist" }),
      {
        status: 401,
        headers: {
          "Access-Control-Allow-Origin": allowedOrigins.includes(origin)
            ? origin
            : "null",
          "Access-Control-Allow-Credentials": "true",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
        },
      }
    );
  }

  const video = query[0];

  if (video.jobId !== null || video.ownerId !== userId) {
    return new Response(JSON.stringify({ assetId: video.jobId }), {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": allowedOrigins.includes(origin)
          ? origin
          : "null",
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
      },
    });
  }

  const bucket = process.env.CAP_AWS_BUCKET || "";
  const videoPrefix = `${userId}/${videoId}/video-with-audio/`;

  try {
    const s3Client = new S3Client({
      region: process.env.CAP_AWS_REGION || "",
      credentials: {
        accessKeyId: process.env.CAP_AWS_ACCESS_KEY || "",
        secretAccessKey: process.env.CAP_AWS_SECRET_KEY || "",
      },
    });

    const videoSegmentCommand = new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: videoPrefix,
    });

    const videoSegments = await s3Client.send(videoSegmentCommand);

    const videoSegmentKeys = (videoSegments.Contents || []).map(
      (object) => `s3://${bucket}/${object.Key}`
    );

    if (videoSegmentKeys.length > 149) {
      await db
        .update(videos)
        .set({ skipProcessing: true })
        .where(eq(videos.id, videoId));
      return new Response(
        JSON.stringify({
          message: "Number of inputs exceeds limit, skipping processing",
        }),
        {
          status: 200,
          headers: {
            "Access-Control-Allow-Origin": allowedOrigins.includes(origin)
              ? origin
              : "null",
            "Access-Control-Allow-Credentials": "true",
            "Access-Control-Allow-Methods": "GET, OPTIONS",
          },
        }
      );
    }

    const mediaConvertClient = new MediaConvertClient({
      region: process.env.CAP_AWS_REGION || "",
      credentials: {
        accessKeyId: process.env.CAP_AWS_ACCESS_KEY || "",
        secretAccessKey: process.env.CAP_AWS_SECRET_KEY || "",
      },
    });

    const outputKey = `${userId}/${videoId}/output/`;

    const createJobCommand = new CreateJobCommand({
      Role: process.env.CAP_AWS_MEDIACONVERT_ROLE_ARN || "",
      Settings: {
        Inputs: videoSegmentKeys.map((videoSegmentKey) => {
          return {
            FileInput: videoSegmentKey,
            AudioSelectors: {
              "Audio Selector 1": {
                DefaultSelection: "DEFAULT",
              },
            },
            VideoSelector: {},
            TimecodeSource: "ZEROBASED",
          };
        }),
        OutputGroups: [
          {
            Name: "Apple HLS",
            OutputGroupSettings: {
              Type: "HLS_GROUP_SETTINGS",
              HlsGroupSettings: {
                Destination: `s3://${bucket}/${outputKey}`,
                SegmentLength: 3,
                MinSegmentLength: 0,
                DirectoryStructure: "SINGLE_DIRECTORY",
                ProgramDateTimePeriod: 600,
                SegmentControl: "SEGMENTED_FILES",
                ManifestDurationFormat: "INTEGER",
                StreamInfResolution: "INCLUDE",
                ClientCache: "ENABLED",
                AudioOnlyHeader: "INCLUDE",
                ProgramDateTime: "EXCLUDE",
              },
            },
            Outputs: [
              {
                NameModifier: "_output",
                ContainerSettings: {
                  Container: "M3U8",
                },
                VideoDescription: {
                  CodecSettings: {
                    Codec: "H_264",
                    H264Settings: {
                      MaxBitrate: 5000000,
                      RateControlMode: "QVBR",
                      QvbrSettings: {
                        QvbrQualityLevel: 7,
                      },
                    },
                  },
                },
                AudioDescriptions: [
                  {
                    AudioSourceName: "Audio Selector 1",
                    CodecSettings: {
                      Codec: "AAC",
                      AacSettings: {
                        Bitrate: 128000,
                        CodingMode: "CODING_MODE_2_0",
                        SampleRate: 48000,
                      },
                    },
                  },
                ],
              },
            ],
          },
        ],
        TimecodeConfig: {
          Source: "ZEROBASED",
        },
      },
    });

    const createJobResponse = await mediaConvertClient.send(createJobCommand);
    const jobId = createJobResponse.Job?.Id;

    await db.update(videos).set({ jobId }).where(eq(videos.id, videoId));

    return new Response(JSON.stringify({ jobId: jobId }), {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": allowedOrigins.includes(origin)
          ? origin
          : "null",
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
      },
    });
  } catch (error) {
    console.error("Error creating Mux asset", error);
    return new Response(
      JSON.stringify({ error: error, message: "Error creating Mux asset" }),
      {
        status: 500,
        headers: {
          "Access-Control-Allow-Origin": allowedOrigins.includes(origin)
            ? origin
            : "null",
          "Access-Control-Allow-Credentials": "true",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
        },
      }
    );
  }
}
