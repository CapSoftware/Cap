"use server";

import { getCurrentUser } from "@cap/database/auth/session";
import { CurrentUser } from "@cap/web-domain";
import { Effect } from "effect";
import { getAllFolders } from "../../lib/folder";
import { runPromise } from "../../lib/server";

export async function getAllFoldersAction(
  root:
    | { variant: "user" }
    | { variant: "space"; spaceId: string }
    | { variant: "org"; organizationId: string }
) {
  try {
    const user = await getCurrentUser();
    if (!user || !user.activeOrganizationId) {
      return {
        success: false as const,
        error: "Unauthorized or no active organization",
      };
    }

    const folders = await runPromise(
      getAllFolders(root).pipe(Effect.provideService(CurrentUser, user))
    );
    return { success: true as const, folders };
  } catch (error) {
    console.error("Error fetching folders:", error);
    return {
      success: false as const,
      error: "Failed to fetch folders",
    };
  }
}
