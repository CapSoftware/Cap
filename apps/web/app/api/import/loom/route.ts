import { type NextRequest } from "next/server";
import { getCurrentUser } from "@cap/database/auth/session";
import {
  users,
  spaces,
  spaceMembers,
  videos,
  sharedVideos,
} from "@cap/database/schema";
import { db } from "@cap/database";
import { eq, inArray, or } from "drizzle-orm";
import { nanoId } from "@cap/database/helpers";
import { z } from "zod";

export interface WorkspaceMember {
  name: string;
  email: string;
  role: string;
  dateJoined: string;
  status: string;
}

export interface VideoOwner {
  name: string;
  email: string;
}

export interface Video {
  id: string;
  owner: VideoOwner;
  title: string;
}

export interface LoomExportData {
  workspaceMembers: WorkspaceMember[];
  videos: Video[];
  selectedWorkspaceId: string;
  userEmail: string;
}

/**
 * Creates user accounts for Loom workspace members
 */
async function createUsersFromLoomWorkspaceMembers(
  workspaceMembers: WorkspaceMember[],
  workspaceId: string
): Promise<string[]> {
  const emails = workspaceMembers.map((member) => member.email);

  const existingUsers = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(inArray(users.email, emails));

  const existingEmails = new Set(existingUsers.map((user) => user.email));
  const newUserIds: string[] = existingUsers.map((user) => user.id);

  for (const member of workspaceMembers.filter(
    (m) => !existingEmails.has(m.email)
  )) {
    const nameParts = member.name.split(" ");
    const firstName = nameParts[0] || "";
    const lastName = nameParts.slice(1).join(" ") || "";

    const userId = nanoId();
    await db.insert(users).values({
      id: userId,
      email: member.email,
      name: firstName,
      lastName: lastName,
      inviteQuota: 1,

      activeSpaceId: workspaceId,
    });

    newUserIds.push(userId);
  }

  return newUserIds;
}

/**
 * Adds users to the owner's workspace
 */
async function addUsersToOwnerWorkspace(
  userIds: string[],
  ownerId: string,
  spaceId: string
): Promise<void> {
  const existingMembers = await db
    .select({ userId: spaceMembers.userId })
    .from(spaceMembers)
    .where(eq(spaceMembers.spaceId, spaceId));

  const existingMemberIds = new Set(
    existingMembers.map((member) => member.userId)
  );

  for (const userId of userIds.filter(
    (id) => !existingMemberIds.has(id) && id !== ownerId
  )) {
    await db.insert(spaceMembers).values({
      id: nanoId(),
      userId: userId,
      spaceId: spaceId,
      role: "member",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const user = await db
      .select({ activeSpaceId: users.activeSpaceId })
      .from(users)
      .where(eq(users.id, userId))
      .then((results) => results[0]);

    if (!user?.activeSpaceId) {
      await db
        .update(users)
        .set({ activeSpaceId: spaceId })
        .where(eq(users.id, userId));
    }
  }
}

/**
 * Downloads a video from Loom's CDN
 * This is an empty function as requested, to be implemented later
 */
async function downloadVideoFromLoom(videoId: string): Promise<{
  videoUrl: string;
  thumbnailUrl: string;
  metadata: Record<string, any>;
}> {
  // TODO: For cap.so team replace this actual upload to S3 implementation

  return {
    videoUrl: `https://placehold.co/600x400/EEE/31343C`,
    thumbnailUrl: `https://placehold.co/600x400/EEE/31343C`,
    metadata: {
      originalLoomId: videoId,
      importedAt: new Date().toISOString(),
    },
  };
}

/**
 * Imports videos from Loom into Cap.so
 */
async function importVideosFromLoom(
  loomVideos: Video[],
  ownerId: string,
  spaceId: string,
  userEmail: string
): Promise<void> {
  for (const loomVideo of loomVideos) {
    try {
      const owner = loomVideo.owner;

      let videoOwnerId = ownerId;

      // If the video owner email matches the user's Loom email, assign it directly to the user
      if (owner && owner.email && owner.email === userEmail) {
        videoOwnerId = ownerId;
      }
      // Otherwise try to find user by email
      else if (owner && owner.email) {
        const existingOwner = await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.email, owner.email))
          .then((results) => results[0]);

        if (existingOwner) {
          videoOwnerId = existingOwner.id;
        }
      }

      const videoData = await downloadVideoFromLoom(loomVideo.id);

      const videoId = nanoId();
      await db.insert(videos).values({
        id: videoId,
        ownerId: videoOwnerId,
        name: loomVideo.title,
        loomVideoId: loomVideo.id,
        public: true,
        metadata: videoData.metadata,
        source: { type: "desktopMP4" },
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      if (videoOwnerId !== ownerId) {
        await db.insert(sharedVideos).values({
          id: nanoId(),
          videoId: videoId,
          spaceId: spaceId,
          sharedByUserId: ownerId,
          sharedAt: new Date(),
        });
      }
    } catch (error) {
      console.error(`Failed to import Loom video ${loomVideo.id}:`, error);
    }
  }
}

const loomExportSchema = z.object({
  workspaceMembers: z.array(
    z.object({
      name: z.string(),
      email: z.string().email(),
      role: z.string(),
      dateJoined: z.string(),
      status: z.string(),
    })
  ),
  videos: z.array(
    z.object({
      id: z.string(),
      owner: z.object({
        name: z.string(),
        email: z.string().email(),
      }),
      title: z.string(),
    })
  ),
  selectedWorkspaceId: z.string(),
  userEmail: z.string().email(),
});

export async function POST(request: NextRequest) {
  try {
    const user = await getCurrentUser();

    if (!user || !user.id) {
      console.error("User not found or unauthorized");
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    const body = loomExportSchema.parse(await request.json());

    let targetSpaceId: string;

    const userSpaces = await db
      .select({ spaceId: spaces.id })
      .from(spaces)
      .leftJoin(spaceMembers, eq(spaces.id, spaceMembers.spaceId))
      .where(or(eq(spaces.ownerId, user.id), eq(spaceMembers.userId, user.id)));

    const hasAccess = userSpaces.some(
      (space) => space.spaceId === body.selectedWorkspaceId
    );

    if (hasAccess) {
      targetSpaceId = body.selectedWorkspaceId;
    } else {
      console.warn(
        `User ${user.id} attempted to import to workspace ${body.selectedWorkspaceId} without access`
      );
      return Response.json(
        { error: "You don't have access to the selected workspace" },
        { status: 403 }
      );
    }

    const userIds = await createUsersFromLoomWorkspaceMembers(
      body.workspaceMembers,
      targetSpaceId
    );

    await addUsersToOwnerWorkspace(userIds, user.id, targetSpaceId);

    await importVideosFromLoom(
      body.videos,
      user.id,
      targetSpaceId,
      body.userEmail
    );

    return Response.json(
      {
        success: true,
        usersCreated: userIds.length,
        videosImported: body.videos.length,
        spaceId: targetSpaceId,
      },
      {
        status: 200,
      }
    );
  } catch (error) {
    console.error("Error importing Loom data:", error);
    return Response.json(
      {
        error: "Failed to import data",
        message: (error as Error).message,
      },
      {
        status: 500,
      }
    );
  }
}
