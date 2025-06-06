"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { spaces, organizations } from "@cap/database/schema";
import { nanoId } from "@cap/database/helpers";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { createS3Client, getS3Bucket } from "@/utils/s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { serverEnv } from "@cap/env";

interface CreateSpaceResponse {
  success: boolean;
  spaceId?: string;
  name?: string;
  iconUrl?: string | null;
  error?: string;
}

export async function createSpace(
  formData: FormData
): Promise<CreateSpaceResponse> {
  try {
    const user = await getCurrentUser();

    if (!user || !user.activeOrganizationId) {
      return {
        success: false,
        error: "User not logged in or no active organization",
      };
    }

    const name = formData.get("name") as string;

    if (!name) {
      return {
        success: false,
        error: "Space name is required",
      };
    }

    // Generate the space ID early so we can use it in the file path
    const spaceId = nanoId();

    const iconFile = formData.get("icon") as File | null;
    let iconUrl = null;

    if (iconFile) {
      // Validate file type
      if (!iconFile.type.startsWith("image/")) {
        return {
          success: false,
          error: "File must be an image",
        };
      }

      // Validate file size (limit to 2MB)
      if (iconFile.size > 2 * 1024 * 1024) {
        return {
          success: false,
          error: "File size must be less than 2MB",
        };
      }

      try {
        // Create a unique file key
        const fileExtension = iconFile.name.split(".").pop();
        const fileKey = `organizations/${
          user.activeOrganizationId
        }/spaces/${spaceId}/icon-${Date.now()}.${fileExtension}`;

        // Get S3 client
        const [s3Client] = await createS3Client();
        const bucketName = await getS3Bucket();

        // Create presigned post
        const presignedPostData = await createPresignedPost(s3Client, {
          Bucket: bucketName,
          Key: fileKey,
          Fields: {
            "Content-Type": iconFile.type,
          },
          Expires: 600, // 10 minutes
        });

        // Upload file to S3
        const formDataForS3 = new FormData();
        Object.entries(presignedPostData.fields).forEach(([key, value]) => {
          formDataForS3.append(key, value as string);
        });
        formDataForS3.append("file", iconFile);

        const uploadResponse = await fetch(presignedPostData.url, {
          method: "POST",
          body: formDataForS3,
        });

        if (!uploadResponse.ok) {
          throw new Error("Failed to upload file to S3");
        }

        // Construct the icon URL
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
      } catch (error) {
        console.error("Error uploading space icon:", error);
        return {
          success: false,
          error: "Failed to upload space icon",
        };
      }
    }

    await db()
      .insert(spaces)
      .values({
        id: spaceId,
        name,
        organizationId: user.activeOrganizationId,
        iconUrl,
        createdById: user.id,
        description: iconUrl ? `Space with custom icon: ${iconUrl}` : null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

    revalidatePath("/dashboard");

    return {
      success: true,
      spaceId,
      name,
      iconUrl,
    };
  } catch (error) {
    console.error("Error creating space:", error);
    return {
      success: false,
      error: "Failed to create space",
    };
  }
}
