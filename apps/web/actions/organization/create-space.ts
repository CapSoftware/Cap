"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { spaces, users, spaceMembers } from "@cap/database/schema";
import { inArray, eq, and } from "drizzle-orm";
import { nanoId, nanoIdLength } from "@cap/database/helpers";
import { revalidatePath } from "next/cache";
import { createBucketProvider } from "@/utils/s3";
import { serverEnv } from "@cap/env";
import { v4 as uuidv4 } from "uuid";

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

    // Check for duplicate space name in the same organization
    const existingSpace = await db()
      .select({ id: spaces.id })
      .from(spaces)
      .where(
        and(
          eq(spaces.organizationId, user.activeOrganizationId),
          eq(spaces.name, name)
        )
      )
      .limit(1);

    if (existingSpace.length > 0) {
      return {
        success: false,
        error: "A space with this name already exists.",
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

        const bucket = await createBucketProvider();

        await bucket.putObject(fileKey, await iconFile.bytes(), {
          contentType: iconFile.type,
        });

        // Construct the icon URL
        if (serverEnv().CAP_AWS_BUCKET_URL) {
          // If a custom bucket URL is defined, use it
          iconUrl = `${serverEnv().CAP_AWS_BUCKET_URL}/${fileKey}`;
        } else if (serverEnv().CAP_AWS_ENDPOINT) {
          // For custom endpoints like MinIO
          iconUrl = `${serverEnv().CAP_AWS_ENDPOINT}/${bucket.name}/${fileKey}`;
        } else {
          // Default AWS S3 URL format
          iconUrl = `https://${bucket.name}.s3.${
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
        createdById: user.id,
        iconUrl,
        description: iconUrl ? `Space with custom icon: ${iconUrl}` : null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

    // --- Member Management Logic ---
    // Collect member emails from formData
    const members: string[] = [];
    for (const entry of formData.getAll("members[]")) {
      if (typeof entry === "string" && entry.length > 0) {
        members.push(entry);
      }
    }

    // Always add the creator as Owner (if not already in the list)
    const memberEmailsSet = new Set(members.map((e) => e.toLowerCase()));
    const creatorEmail = user.email.toLowerCase();
    if (!memberEmailsSet.has(creatorEmail)) {
      members.push(user.email);
    }

    // Look up user IDs for each email
    if (members.length > 0) {
      // Fetch all users with these emails
      const usersFound = await db()
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(inArray(users.email, members));

      // Map email to userId
      const emailToUserId = Object.fromEntries(
        usersFound.map((u) => [u.email.toLowerCase(), u.id])
      );

      // Prepare spaceMembers insertions
      const spaceMembersToInsert = members
        .map((email) => {
          const userId = emailToUserId[email.toLowerCase()];
          if (!userId) return null;
          // Creator is always Owner, others are Member
          const role =
            email.toLowerCase() === creatorEmail ? "Admin" : "Member";
          return {
            id: uuidv4().substring(0, nanoIdLength),
            spaceId,
            userId,
            role,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
        })
        .filter((v): v is NonNullable<typeof v> => Boolean(v));

      if (spaceMembersToInsert.length > 0) {
        await db().insert(spaceMembers).values(spaceMembersToInsert);
      }
    }

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
