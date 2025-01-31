import { S3_BUCKET_URL } from "@cap/utils";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { clientEnv } from "@cap/env";

export const playlistToMp4 = async (
  userId: string,
  videoId: string,
  videoName: string
) => {
  const ffmpeg = new FFmpeg();
  await ffmpeg.load();

  if (!ffmpeg) {
    throw new Error("FFmpeg not loaded");
  }

  const videoFetch = await fetch(
    `${clientEnv.NEXT_PUBLIC_WEB_URL}/api/video/playlistUrl?userId=${userId}&videoId=${videoId}`
  );

  if (videoFetch.status !== 200) {
    throw new Error("Could not fetch video");
  }

  const video = await videoFetch.json();

  if (!video.playlistOne) {
    throw new Error("Video does not have a valid video playlist");
  }

  // Fetch the video playlist data
  const videoResponse = await fetch(video.playlistOne);
  const videoData = await videoResponse.text();
  const videoUrls = videoData
    .split("\n")
    .filter((line) => line && !line.startsWith("#"));

  // Download video files and write to FFmpeg FS
  for (const [index, url] of videoUrls.entries()) {
    const fullUrl = url.startsWith("https")
      ? url
      : `${S3_BUCKET_URL}/${userId}/${videoId}/output/${url}`;
    const segmentResponse = await fetch(fullUrl);
    const segmentData = new Uint8Array(await segmentResponse.arrayBuffer());
    await ffmpeg.writeFile(`video${index}.ts`, segmentData);
  }

  // Concatenate all video files using FFmpeg
  const videoConcatList = videoUrls
    .map((_, index) => `file 'video${index}.ts'`)
    .join("\n");
  await ffmpeg.writeFile("videolist.txt", videoConcatList);

  if (video.playlistTwo) {
    // Fetch the audio playlist data if available
    const audioResponse = await fetch(video.playlistTwo);
    const audioData = await audioResponse.text();
    const audioUrls = audioData
      .split("\n")
      .filter((line) => line && !line.startsWith("#"));

    // Download audio files and write to FFmpeg FS
    for (const [index, url] of audioUrls.entries()) {
      const fullUrl = url.startsWith("https")
        ? url
        : `${S3_BUCKET_URL}/tzv973qb6ghnznf/z3ha0dv61q5hrdw/output/${url}`;
      const segmentResponse = await fetch(fullUrl);
      const segmentData = new Uint8Array(await segmentResponse.arrayBuffer());
      await ffmpeg.writeFile(`audio${index}.ts`, segmentData);
    }

    // Concatenate all audio files using FFmpeg
    const audioConcatList = audioUrls
      .map((_, index) => `file 'audio${index}.ts'`)
      .join("\n");
    await ffmpeg.writeFile("audiolist.txt", audioConcatList);

    // Merge video and audio into final MP4
    await ffmpeg.exec([
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      "videolist.txt",
      "-c",
      "copy",
      "temp_video.mp4",
    ]);
    await ffmpeg.exec([
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      "audiolist.txt",
      "-c",
      "copy",
      "temp_audio.mp4",
    ]);
    await ffmpeg.exec([
      "-i",
      "temp_video.mp4",
      "-i",
      "temp_audio.mp4",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-async",
      "1", // Adjusts audio to match the number of video frames
      "-vsync",
      "1", // Ensures frames are handled correctly
      "-copyts", // Copy timestamps
      videoName + ".mp4",
    ]);
  } else {
    // Only video available, process as single MP4
    await ffmpeg.exec([
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      "videolist.txt",
      "-c",
      "copy",
      videoName + ".mp4",
    ]);
  }

  // Read the result and create a Blob
  const mp4Data = await ffmpeg.readFile(videoName + ".mp4");
  const mp4Blob = new Blob([mp4Data], { type: "video/mp4" });

  return mp4Blob;
};

export function generateM3U8Playlist(
  urls: {
    url: string;
    duration: string;
    resolution?: string;
    bandwidth?: string;
  }[]
) {
  const baseM3U8Content = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:5
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
`;

  let m3u8Content = baseM3U8Content;
  urls.forEach((segment) => {
    const { url, duration } = segment;
    m3u8Content += `#EXTINF:${duration},\n${url.replace(
      "https://capso.s3.us-east-1.amazonaws.com",
      "https://v.cap.so"
    )}\n`;
  });

  m3u8Content += "#EXT-X-ENDLIST";

  return m3u8Content;
}

export async function generateMasterPlaylist(
  resolution: string,
  bandwidth: string,
  videoPlaylistUrl: string,
  audioPlaylistUrl: string | null,
  xStreamInfo: string
) {
  const streamInfo = xStreamInfo
    ? xStreamInfo + ',AUDIO="audio"'
    : `BANDWIDTH=${bandwidth},RESOLUTION=${resolution},AUDIO="audio"`;
  const masterPlaylist = `#EXTM3U
#EXT-X-VERSION:4
#EXT-X-INDEPENDENT-SEGMENTS
${
  audioPlaylistUrl
    ? `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Audio",DEFAULT=YES,AUTOSELECT=YES,LANGUAGE="en",URI="${audioPlaylistUrl}"`
    : ""
}
#EXT-X-STREAM-INF:${streamInfo}
${videoPlaylistUrl}
`;

  return masterPlaylist;
}
