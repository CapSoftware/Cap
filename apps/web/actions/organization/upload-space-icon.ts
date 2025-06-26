"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { spaces } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { createBucketProvider } from "@/utils/s3";
import { sanitizeFile } from "@/lib/sanitizeFile";

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

  const bucket = await createBucketProvider();

  try {
    // Remove previous icon if exists
    if (space.iconUrl) {
      // Try to extract the previous S3 key from the URL
      const prevKeyMatch = space.iconUrl.match(/organizations\/.+/);
      if (prevKeyMatch && prevKeyMatch[0]) {
        try {
          await bucket.deleteObject(prevKeyMatch[0]);
        } catch (e) {
          // Log and continue
          console.warn("Failed to delete old space icon from S3", e);
        }
      }
    }

    const sanitizedFile = await sanitizeFile(file);

    await bucket.putObject(fileKey, await sanitizedFile.bytes(), {
      contentType: file.type,
    });

    // Construct the icon URL
    let iconUrl;
    if (serverEnv().CAP_AWS_BUCKET_URL) {
      iconUrl = `${serverEnv().CAP_AWS_BUCKET_URL}/${fileKey}`;
    } else if (serverEnv().CAP_AWS_ENDPOINT) {
      iconUrl = `${serverEnv().CAP_AWS_ENDPOINT}/${bucket.name}/${fileKey}`;
    } else {
      iconUrl = `https://${bucket.name}.s3.${
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
