export async function uploadToS3(
  filename: string,
  blobData: string | Blob,
  userId: string,
  awsBucket: string,
  awsRegion: string
) {
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
  // Append the file (blobData) to the formData
  formData.append("file", blobData);

  // Execute the upload using the presigned URL
  const uploadResponse = await fetch(presignedPostData.url, {
    method: "POST",
    body: formData,
  });

  if (!uploadResponse.ok) {
    return false;
  }

  // Optionally return the S3 URL or any other info you need
  return true;
}
