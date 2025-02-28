import NextAuth from "next-auth";
import { authOptions } from "@cap/database/auth/auth-options";
import type { NextAuthOptions } from "next-auth";
import type { User, Account, Profile } from "next-auth";
import { getServerConfig } from "@/utils/instance/functions";
import { db } from "@cap/database";
import { eq } from "drizzle-orm";
import { spaceInvites, users } from "@cap/database/schema";

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
      const serverConfig = await getServerConfig();

      // If CapCloud or signups are enabled, allow all sign-ins and registrations
      if (serverConfig.isCapCloud || serverConfig.signupsEnabled) {
        return true;
      }

      // If no email, reject sign-in
      if (!params.user.email) {
        return false;
      }

      const existingUser = await db.query.users.findFirst({
        where: eq(users.email, params.user.email),
      });

      // If user exists, allow sign-in
      if (existingUser) {
        return true;
      }

      // If user is invited, allow sign-in (workaround for signups being disabled)
      const matchedInvitedUser = await db.query.spaceInvites.findFirst({
        where: eq(spaceInvites.invitedEmail, params.user.email),
      });

      if (matchedInvitedUser) {
        return true;
      }

      // If user doesn't exist, isnt invited and signups are disabled, redirect to login page with error
      return `/login?error=signupDisabled`;
    },
  },
};

const handler = NextAuth(extendedAuthOptions);

export { handler as GET, handler as POST };
