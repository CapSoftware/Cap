import { serverEnv } from "@cap/env";

export async function uploadToS3({
  filename,
  blobData,
  userId,
  duration,
  resolution,
  videoCodec,
  audioCodec,
  awsBucket,
  awsRegion,
  onProgress,
}: {
  filename: string;
  blobData: Blob;
  userId: string;
  duration?: string;
  resolution?: string;
  videoCodec?: string;
  audioCodec?: string;
  awsBucket: string;
  awsRegion: string;
  onProgress?: (progress: number) => void;
}) {
  const response = await fetch(`${serverEnv().WEB_URL}/api/upload/signed`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      userId: userId,
      fileKey: filename,
      duration: duration,
      resolution: resolution,
      videoCodec: videoCodec,
      audioCodec: audioCodec,
      awsBucket: awsBucket,
      awsRegion: awsRegion,
    }),
  });

  const { presignedPostData } = await response.json();

  const formData = new FormData();
  Object.entries(presignedPostData.fields).forEach(([key, value]) => {
    formData.append(key, value as string);
  });
  formData.append("file", blobData);

  const uploadResponse: boolean = await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", presignedPostData.url);

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        const percent = (event.loaded / event.total) * 100;
        onProgress(percent);
      }
    };

    xhr.onload = () => {
      resolve(xhr.status >= 200 && xhr.status < 300);
    };
    xhr.onerror = () => reject(new Error("Upload failed"));

    xhr.send(formData);
  });

  return uploadResponse;
}
