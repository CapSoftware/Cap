import { decrypt } from "@cap/database/crypto";
import { videos } from "@cap/database/schema";
import { InferSelectModel } from "drizzle-orm";
import { cookies } from "next/headers";

async function verifyPasswordCookie(videoPassword: string) {
  try {
    // Safely access cookies with error handling
    const cookieStore = cookies();
    const password = cookieStore.get("x-cap-password")?.value;
    if (!password) return false;

    const decrypted = await decrypt(password).catch(() => "");
    return decrypted === videoPassword;
  } catch (error) {
    console.error("[verifyPasswordCookie] Error accessing cookies:", error);
    return false; // Fail safely by denying access if cookies can't be accessed
  }
}

export async function userHasAccessToVideo(
  user: MaybePromise<{ id: string } | undefined | null>,
  video: InferSelectModel<typeof videos>
): Promise<"has-access" | "private" | "needs-password" | "not-org-email"> {
  try {
    // Public videos without password are always accessible
    if (video.public && video.password === null) return "has-access";

    // Safely resolve user promise with error handling
    let _user;
    try {
      _user = await user;
    } catch (error) {
      console.error("[userHasAccessToVideo] Error resolving user:", error);
      _user = null; // Treat as unauthenticated if user resolution fails
    }

    // Private videos require authentication and ownership
    if (video.public === false && (!_user || _user.id !== video.ownerId))
      return "private";

    // No password needed
    if (video.password === null) return "has-access";

    // Check password cookie
    if (!(await verifyPasswordCookie(video.password))) return "needs-password";
    
    return "has-access";
  } catch (error) {
    console.error("[userHasAccessToVideo] Unexpected error:", error);
    // Default to requiring password for safety in case of errors
    return video.password ? "needs-password" : "private";
  }
}
