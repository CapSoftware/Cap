import { FFmpeg as FfmpegType } from "@ffmpeg/ffmpeg";
import { fetchFile } from "@ffmpeg/util";

export const concatenateSegments = async (
  ffmpeg: FfmpegType,
  segmentsUrls: string[],
  videoId: string,
  outputFilename: string,
  inputFormat: string,
  outputFormat: string
) => {
  if (!ffmpeg) {
    throw new Error("FFmpeg not loaded");
  }

  console.log("Running concatenateSegments...");

  console.log("concatenateSegments:", segmentsUrls);

  await ffmpeg.load();

  // Feed the video segments to FFmpeg
  for (let i = 0; i < segmentsUrls.length; i++) {
    console.log("Fetching file...");
    const fetchedFile = await fetchFile(segmentsUrls[i]);
    ffmpeg.writeFile(`file${i}.${inputFormat}`, fetchedFile);
  }

  // Create a file with all the file names
  const fileList = "file_list.txt";
  const concatList = segmentsUrls
    .map((url, index) => `file file${index}.${inputFormat}`)
    .join("\n");
  ffmpeg.writeFile(fileList, concatList);

  console.log("Concatenating using ffmpeg script...");

  await ffmpeg.exec([
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    fileList,
    "-r",
    `${outputFilename === "video_output.mp4" ? 30 : 60}`,
    "-c",
    "copy",
    outputFilename,
  ]);

  // Read the resulting file
  const data = await ffmpeg.readFile(outputFilename);

  // // Convert the data to a Blob
  // const blob = new Blob([data], {
  //   type: `video/${outputFormat}`,
  // });

  // console.log("Uploading to S3...");

  // const formData = new FormData();
  // formData.append("filename", outputFilename);
  // formData.append("videoId", videoId);
  // formData.append("blobData", blob);

  // await fetch(`${process.env.NEXT_PUBLIC_URL}/api/upload/new`, {
  //   method: "POST",
  //   body: formData,
  // });

  // Return the URL to the MP4 on S3
  return data;
};

export async function generateM3U8Playlist(
  urls: { url: string; duration: string }[]
) {
  const baseM3U8Content = `#EXTM3U
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:4
#EXT-X-VERSION:4
#EXT-X-MEDIA-SEQUENCE:0
`;

  let m3u8Content = baseM3U8Content;
  urls.forEach((url) => {
    m3u8Content += `#EXTINF:${url.duration},\n${url.url}\n`;
  });

  m3u8Content += "#EXT-X-ENDLIST";

  return m3u8Content;
}
