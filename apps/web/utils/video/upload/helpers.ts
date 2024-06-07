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
}) {
  const response = await fetch(
    `${process.env.NEXT_PUBLIC_URL}/api/upload/signed`,
    {
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
    }
  );

  const { presignedPostData } = await response.json();

  const formData = new FormData();
  Object.entries(presignedPostData.fields).forEach(([key, value]) => {
    formData.append(key, value as string);
  });
  formData.append("file", blobData);

  const uploadResponse = await fetch(presignedPostData.url, {
    method: "POST",
    body: formData,
  });

  if (!uploadResponse.ok) {
    return false;
  }

  return true;
}
