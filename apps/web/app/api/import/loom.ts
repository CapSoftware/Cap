import { zValidator } from "@hono/zod-validator";
import {
  users,
  spaces,
  spaceMembers,
  videos,
  sharedVideos,
  organizationMembers,
} from "@cap/database/schema";
import { db } from "@cap/database";
import { eq, inArray, or } from "drizzle-orm";
import { nanoId } from "@cap/database/helpers";
import { z } from "zod";
import { Hono } from "hono";

import { withAuth } from "../utils";

const WorkspaceMember = z.object({
  name: z.string(),
  email: z.string().email(),
  role: z.string(),
  dateJoined: z.string(),
  status: z.string(),
});

type WorkspaceMember = z.infer<typeof WorkspaceMember>;

const Video = z.object({
  id: z.string(),
  owner: z.object({
    name: z.string(),
    email: z.string().email(),
  }),
  title: z.string(),
});

type Video = z.infer<typeof Video>;

export const app = new Hono().use(withAuth);

app.post(
  "/",
  zValidator(
    "json",
    z.object({
      workspaceMembers: z.array(WorkspaceMember),
      videos: z.array(Video),
      selectedWorkspaceId: z.string(),
      userEmail: z.string().email(),
    })
  ),
  async (c) => {
    try {
      const user = c.get("user");
      const body = c.req.valid("json");

      let targetSpaceId: string;

      const userSpaces = await db()
        .select({ spacesId: spaces.id })
        .from(spaces)
        .leftJoin(spaceMembers, eq(spaces.id, spaceMembers.spaceId))
        .where(
          or(eq(spaces.createdById, user.id), eq(spaceMembers.userId, user.id))
        );

      const hasAccess = userSpaces.some(
        (space) => space.spacesId === body.selectedWorkspaceId
      );

      if (hasAccess) {
        targetSpaceId = body.selectedWorkspaceId;
      } else {
        console.warn(
          `User ${user.id} attempted to import to workspace ${body.selectedWorkspaceId} without access`
        );
        return c.json(
          { error: "You don't have access to the selected workspace" },
          { status: 403 }
        );
      }

      const userIds = await createUsersFromLoomWorkspaceMembers(
        body.workspaceMembers,
        targetSpaceId
      );

      await addUsersToOwnerOrganization(userIds, user.id, targetSpaceId);

      await importVideosFromLoom(
        body.videos,
        user.id,
        targetSpaceId,
        body.userEmail
      );

      return c.json({
        success: true,
        usersCreated: userIds.length,
        videosImported: body.videos.length,
        spaceId: targetSpaceId,
      });
    } catch (error) {
      console.error("Error importing Loom data:", error);
      return c.json(
        {
          error: "Failed to import data",
          message: (error as Error).message,
        },
        { status: 500 }
      );
    }
  }
);

/**
 * Creates user accounts for Loom workspace members
 */
async function createUsersFromLoomWorkspaceMembers(
  organizationMembers: WorkspaceMember[],
  organizationId: string
) {
  const emails = organizationMembers.map((member) => member.email);

  const existingUsers = await db()
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(inArray(users.email, emails));

  const existingEmails = new Set(existingUsers.map((user) => user.email));
  const newUserIds: string[] = existingUsers.map((user) => user.id);

  for (const member of organizationMembers.filter(
    (m) => !existingEmails.has(m.email)
  )) {
    const nameParts = member.name.split(" ");
    const firstName = nameParts[0] || "";
    const lastName = nameParts.slice(1).join(" ") || "";

    const userId = nanoId();
    await db().insert(users).values({
      id: userId,
      email: member.email,
      name: firstName,
      lastName: lastName,
      inviteQuota: 1,
      activeOrganizationId: organizationId,
    });

    newUserIds.push(userId);
  }

  return newUserIds;
}

/**
 * Adds users to the owner's organization
 */
async function addUsersToOwnerOrganization(
  userIds: string[],
  ownerId: string,
  organizationId: string
) {
  const existingMembers = await db()
    .select({ userId: organizationMembers.userId })
    .from(organizationMembers)
    .where(eq(organizationMembers.organizationId, organizationId));

  const existingMemberIds = new Set(
    existingMembers.map((member) => member.userId)
  );

  for (const userId of userIds.filter(
    (id) => !existingMemberIds.has(id) && id !== ownerId
  )) {
    await db().insert(organizationMembers).values({
      id: nanoId(),
      userId: userId,
      organizationId: organizationId,
      role: "member",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const user = await db()
      .select({ activeOrganizationId: users.activeOrganizationId })
      .from(users)
      .where(eq(users.id, userId))
      .then((results) => results[0]);

    if (!user?.activeOrganizationId) {
      await db()
        .update(users)
        .set({ activeOrganizationId: organizationId })
        .where(eq(users.id, userId));
    }
  }
}

/**
 * Downloads a video from Loom's CDN
 * This is an empty function as requested, to be implemented later
 */
async function downloadVideoFromLoom(videoId: string) {
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
  organizationId: string,
  userEmail: string
) {
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
        const existingOwner = await db()
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
      await db().insert(videos).values({
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
        await db().insert(sharedVideos).values({
          id: nanoId(),
          videoId: videoId,
          organizationId: organizationId,
          sharedByUserId: ownerId,
          sharedAt: new Date(),
        });
      }
    } catch (error) {
      console.error(`Failed to import Loom video ${loomVideo.id}:`, error);
    }
  }
}
