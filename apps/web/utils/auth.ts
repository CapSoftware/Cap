import { decrypt } from "@cap/database/crypto";
import { videos } from "@cap/database/schema";
import { InferSelectModel } from "drizzle-orm";
import { cookies } from "next/headers";

async function verifyPasswordCookie(videoPassword: string) {
  const password = cookies().get("x-cap-password")?.value;
  if (!password) return false;

  const decrypted = await decrypt(password).catch(() => "");
  return decrypted === videoPassword;
}

export async function userHasAccessToVideo(
  user: { id: string } | undefined | null,
  video: InferSelectModel<typeof videos>
): Promise<"has-access" | "private" | "needs-password"> {
  if (video.public === false && (!user || user.id !== video.ownerId))
    return "private";
  if (video.password === null) return "has-access";
  if (!(await verifyPasswordCookie(video.password))) return "needs-password";
  return "has-access";
}
