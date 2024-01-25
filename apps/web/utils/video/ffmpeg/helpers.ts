import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile } from "@ffmpeg/util";
import { useRef, useEffect } from "react";

export const concatenateSegments = async (
  segmentsUrls: string[],
  outputFilename: string,
  inputFormat: string,
  outputFormat: string
) => {
  const ffmpegRef = useRef(new FFmpeg());
  const ffmpeg = ffmpegRef.current;

  await ffmpeg.load();

  // Feed the video segments to FFmpeg
  for (let i = 0; i < segmentsUrls.length; i++) {
    const fetchedFile = await fetchFile(segmentsUrls[i]);
    ffmpeg.writeFile(`file${i}.${inputFormat}`, fetchedFile);
  }

  // Create a file with all the file names
  const fileList = "file_list.txt";
  const concatList = segmentsUrls
    .map((url, index) => `file file${index}.${inputFormat}`)
    .join("\n");
  ffmpeg.writeFile(fileList, concatList);

  // Run the FFmpeg command to concatenate
  await ffmpeg.exec([
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    fileList,
    "-c",
    "copy",
    outputFilename,
  ]);

  // Read the resulting file
  const data = ffmpeg.readFile(outputFilename);

  // Convert the data to a Blob
  // const videoBlob = new Blob([data.buffer], { type: `video/${outputFormat}` });

  // // Create a URL for the Blob
  // const videoUrl = URL.createObjectURL(videoBlob);

  // Return the URL to the MP4 on S3
  return data;
};
