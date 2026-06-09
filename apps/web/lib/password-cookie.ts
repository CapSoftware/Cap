import "server-only";

import { encrypt } from "@cap/database/crypto";
import { cookies } from "next/headers";

/**
 * Marks a share password (video or collection) as verified for this browser
 * session. The cookie is shared by the `/s/` and `/c/` flows, holds only the
 * encrypted hash, and is never read client-side — so it can be locked down.
 */
export async function setVerifiedPasswordCookie(passwordHash: string) {
	(await cookies()).set("x-cap-password", await encrypt(passwordHash), {
		httpOnly: true,
		secure: process.env.NODE_ENV === "production",
		sameSite: "lax",
		path: "/",
	});
}
