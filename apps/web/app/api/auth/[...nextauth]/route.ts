import NextAuth from "next-auth";
import { authOptions } from "@cap/database/auth/auth-options";
import type { NextAuthOptions } from "next-auth";
import type { User, Account, Profile } from "next-auth";
import { getServerConfig } from "@/utils/instance/functions";
import { db } from "@cap/database";
import { eq } from "drizzle-orm";
import { users } from "@cap/database/schema";

// Create a modified version of authOptions with additional signIn callback to disable signups if the server is not CapCloud or signups are disabled
const extendedAuthOptions: NextAuthOptions = {
  ...authOptions,
  callbacks: {
    ...authOptions.callbacks,
    async signIn(params: {
      user: User;
      account: Account | null;
      profile?: Profile;
      email?: { verificationRequest?: boolean };
      credentials?: Record<string, any>;
    }) {
      console.log("🔥", { params, user: params.user });

      const serverConfig = await getServerConfig();

      // If CapCloud or signups are enabled, allow all sign-ins
      if (serverConfig.isCapCloud || serverConfig.signupsEnabled) {
        return true;
      }

      // If no email, reject sign-in
      if (!params.user.email) {
        return false;
      }

      // If signups are disabled, only allow users who already exist to sign in
      const existingUser = await db.query.users.findFirst({
        where: eq(users.email, params.user.email),
      });

      // If user exists, allow sign-in
      if (existingUser) {
        return true;
      }

      console.log("🔥 redirecting");
      // If user doesn't exist and signups are disabled, redirect to login page with error
      return `/login?error=signupDisabled`;
    },
  },
};

const handler = NextAuth(extendedAuthOptions);

export { handler as GET, handler as POST };
