"use server";

import { getCurrentUser } from "@cap/database/auth/session";
import { spaces } from "@cap/database/schema";
import { db } from "@cap/database";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { createBucketProvider, createS3Client, getS3Bucket } from "@/utils/s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { serverEnv } from "@cap/env";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";

export async function uploadSpaceIcon(formData: FormData, spaceId: string) {
  const user = await getCurrentUser();

  if (!user) {
    throw new Error("Unauthorized");
  }

  // Fetch the space and check permissions
  const spaceArr = await db()
    .select()
    .from(spaces)
    .where(eq(spaces.id, spaceId));

  if (!spaceArr || spaceArr.length === 0) {
    throw new Error("Space not found");
  }
  const space = spaceArr[0];

  if (!space) {
    throw new Error("Space not found");
  }

  if (space.organizationId !== user.activeOrganizationId) {
    throw new Error("You do not have permission to update this space");
  }

  const file = formData.get("icon") as File;
  if (!file) {
    throw new Error("No file provided");
  }
  if (!file.type.startsWith("image/")) {
    throw new Error("File must be an image");
  }
  if (file.size > 2 * 1024 * 1024) {
    throw new Error("File size must be less than 2MB");
  }

  // Prepare new file key
  const fileExtension = file.name.split(".").pop();
  const fileKey = `organizations/${
    space.organizationId
  }/spaces/${spaceId}/icon-${Date.now()}.${fileExtension}`;

  try {
    const [s3Client] = await createS3Client();
    const bucketName = await getS3Bucket();

    // Remove previous icon if exists
    if (space.iconUrl) {
      // Try to extract the previous S3 key from the URL
      const prevKeyMatch = space.iconUrl.match(/organizations\/.+/);
      if (prevKeyMatch && prevKeyMatch[0]) {
        try {
          await s3Client.send(
            new DeleteObjectCommand({
              Bucket: bucketName,
              Key: prevKeyMatch[0],
            })
          );
        } catch (e) {
          // Log and continue
          console.warn("Failed to delete old space icon from S3", e);
        }
      }
    }

    // Create presigned post
    const presignedPostData = await createPresignedPost(s3Client, {
      Bucket: bucketName,
      Key: fileKey,
      Fields: {
        "Content-Type": file.type,
      },
      Expires: 600, // 10 minutes
    });

    // Upload file to S3
    const formDataForS3 = new FormData();
    Object.entries(presignedPostData.fields).forEach(([key, value]) => {
      formDataForS3.append(key, value as string);
    });
    formDataForS3.append("file", file);

    const uploadResponse = await fetch(presignedPostData.url, {
      method: "POST",
      body: formDataForS3,
    });
    if (!uploadResponse.ok) {
      throw new Error("Failed to upload file to S3");
    }

    // Construct the icon URL
    let iconUrl;
    if (serverEnv().CAP_AWS_BUCKET_URL) {
      iconUrl = `${serverEnv().CAP_AWS_BUCKET_URL}/${fileKey}`;
    } else if (serverEnv().CAP_AWS_ENDPOINT) {
      iconUrl = `${serverEnv().CAP_AWS_ENDPOINT}/${bucketName}/${fileKey}`;
    } else {
      iconUrl = `https://${bucketName}.s3.${
        serverEnv().CAP_AWS_REGION || "us-east-1"
      }.amazonaws.com/${fileKey}`;
    }

    // Update space with new icon URL
    await db().update(spaces).set({ iconUrl }).where(eq(spaces.id, spaceId));

    revalidatePath("/dashboard");
    return { success: true, iconUrl };
  } catch (error) {
    console.error("Error uploading space icon:", error);
    throw new Error(error instanceof Error ? error.message : "Upload failed");
  }
}
