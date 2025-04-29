import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import {
  spaceMembers,
  spaces,
  sharedVideos,
  users,
} from "@cap/database/schema";
import { count, eq, and, or } from "drizzle-orm";
import { Metadata } from "next";
import { redirect } from "next/navigation";
import { Spaces } from "./Spaces";

export const metadata: Metadata = {
  title: "Spaces — Cap",
};

export const revalidate = 0;

export default async function SpacesPage({
  searchParams,
}: {
  searchParams: { [key: string]: string | string[] | undefined };
}) {
  const user = await getCurrentUser();

  if (!user || !user.id) {
    redirect("/login");
  }

  if (!user.name || user.name.length <= 1) {
    redirect("/onboarding");
  }

  const userId = user.id;
  const page = Number(searchParams.page) || 1;
  const limit = Number(searchParams.limit) || 15;
  const offset = (page - 1) * limit;

  // Get spaces the user is a member of or owns
  const totalCountResult = await db
    .select({ count: count() })
    .from(spaces)
    .leftJoin(spaceMembers, eq(spaces.id, spaceMembers.spaceId))
    .where(or(eq(spaces.ownerId, userId), eq(spaceMembers.userId, userId)));

  const totalCount = totalCountResult[0]?.count || 0;

  // Fetch all spaces with counts and role information
  const spacesData = await Promise.all(
    (
      await db
        .select({
          id: spaces.id,
          name: spaces.name,
          ownerId: spaces.ownerId,
        })
        .from(spaces)
        .leftJoin(spaceMembers, eq(spaces.id, spaceMembers.spaceId))
        .where(or(eq(spaces.ownerId, userId), eq(spaceMembers.userId, userId)))
        .limit(limit)
        .offset(offset)
    ).map(async (space) => {
      // Get member count
      const membersCount = await db
        .select({ count: count() })
        .from(spaceMembers)
        .where(eq(spaceMembers.spaceId, space.id));

      // Get videos count
      const videosCount = await db
        .select({ count: count() })
        .from(sharedVideos)
        .where(eq(sharedVideos.spaceId, space.id));

      // Determine user role
      const isOwner = space.ownerId === userId;
      const role = isOwner ? "Owner" : "Member";

      return {
        id: space.id,
        name: space.name,
        members: membersCount[0]?.count || 0,
        videos: videosCount[0]?.count || 0,
        role: role,
      };
    })
  );

  return <Spaces data={spacesData} count={totalCount} user={user} />;
}
