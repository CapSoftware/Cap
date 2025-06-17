"use server";

import { getCurrentUser } from "@cap/database/auth/session";
import { organizations } from "@cap/database/schema";
import { db } from "@cap/database";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { createS3Client, getS3Bucket } from "@/utils/s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { serverEnv } from "@cap/env";

export async function uploadOrganizationIcon(
  formData: FormData,
  organizationId: string
) {
  const user = await getCurrentUser();

  if (!user) {
    throw new Error("Unauthorized");
  }

  const organization = await db()
    .select()
    .from(organizations)
    .where(eq(organizations.id, organizationId));

  if (!organization || organization.length === 0) {
    throw new Error("Organization not found");
  }

  if (organization[0]?.ownerId !== user.id) {
    throw new Error("Only the owner can update organization icon");
  }

  const file = formData.get("file") as File;

  if (!file) {
    throw new Error("No file provided");
  }

  // Validate file type
  if (!file.type.startsWith("image/")) {
    throw new Error("File must be an image");
  }

  // Validate file size (limit to 2MB)
  if (file.size > 2 * 1024 * 1024) {
    throw new Error("File size must be less than 2MB");
  }

  // Create a unique file key
  const fileExtension = file.name.split(".").pop();
  const fileKey = `organizations/${organizationId}/icon-${Date.now()}.${fileExtension}`;

  try {
    // Get S3 client
    const [s3Client] = await createS3Client();
    const bucketName = await getS3Bucket();

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
      // If a custom bucket URL is defined, use it
      iconUrl = `${serverEnv().CAP_AWS_BUCKET_URL}/${fileKey}`;
    } else if (serverEnv().CAP_AWS_ENDPOINT) {
      // For custom endpoints like MinIO
      iconUrl = `${serverEnv().CAP_AWS_ENDPOINT}/${bucketName}/${fileKey}`;
    } else {
      // Default AWS S3 URL format
      iconUrl = `https://${bucketName}.s3.${
        serverEnv().CAP_AWS_REGION || "us-east-1"
      }.amazonaws.com/${fileKey}`;
    }

    // Update organization with new icon URL
    await db()
      .update(organizations)
      .set({
        iconUrl,
      })
      .where(eq(organizations.id, organizationId));

    revalidatePath("/dashboard/settings/organization");

    return { success: true, iconUrl };
  } catch (error) {
    console.error("Error uploading organization icon:", error);
    throw new Error(error instanceof Error ? error.message : "Upload failed");
  }
}
