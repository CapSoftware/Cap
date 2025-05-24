import NextAuth from "next-auth";
import { authOptions } from "@cap/database/auth/auth-options";

export const dynamic = "force-dynamic";

const handler = NextAuth(authOptions());

export { handler as GET, handler as POST };
