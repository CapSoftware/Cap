"use server";

import { getCurrentUser } from "@cap/database/auth/session";
import { spaces } from "@cap/database/schema";
import { db } from "@cap/database";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function removeWorkspaceDomain(spaceId: string) {
  const user = await getCurrentUser();

  if (!user) {
    throw new Error("Unauthorized");
  }

  const [space] = await db()
    .select()
    .from(spaces)
    .where(eq(spaces.id, spaceId));

  if (!space || space.ownerId !== user.id) {
    throw new Error("Only the owner can remove the custom domain");
  }

  try {
    if (space.customDomain) {
      await fetch(
        `https://api.vercel.com/v9/projects/${
          process.env.VERCEL_PROJECT_ID
        }/domains/${space.customDomain.toLowerCase()}?teamId=${
          process.env.VERCEL_TEAM_ID
        }`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${process.env.VERCEL_AUTH_TOKEN}`,
          },
        }
      );
    }

    await db
      .update(spaces)
      .set({
        customDomain: null,
        domainVerified: null,
      })
      .where(eq(spaces.id, spaceId));

    revalidatePath("/dashboard/settings/workspace");

    return { success: true };
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(error.message);
    }
    throw new Error("Failed to remove domain");
  }
}
