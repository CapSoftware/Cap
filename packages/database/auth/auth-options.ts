import { eq } from "drizzle-orm";
import { DrizzleAdapter } from "./drizzle-adapter";
import { db } from "../";
import { users } from "../schema";
import EmailProvider from "next-auth/providers/email";
import type { NextAuthOptions } from "next-auth";
import { sendEmail } from "../emails/config";
import { LoginLink } from "../emails/login-link";

const VERCEL_DEPLOYMENT = !!process.env.VERCEL_URL;

export const config = {
  maxDuration: 120,
};

export const authOptions: NextAuthOptions = {
  adapter: DrizzleAdapter(db),
  debug: true,
  session: {
    strategy: "jwt",
  },
  secret: process.env.NEXTAUTH_SECRET,
  pages: {
    signIn: "/login",
  },
  providers: [
    EmailProvider({
      sendVerificationRequest({ identifier, url }) {
        sendEmail({
          email: identifier,
          subject: `Your Cap Login Link`,
          react: LoginLink({ url, email: identifier }),
        });
      },
    }),
  ],
  cookies: {
    sessionToken: {
      name: `${VERCEL_DEPLOYMENT ? "__Secure-" : ""}next-auth.session-token`,
      options: {
        httpOnly: true,
        sameSite: "none",
        path: "/",
        domain: VERCEL_DEPLOYMENT ? ".cap.so" : undefined,
        secure: VERCEL_DEPLOYMENT,
      },
    },
  },
  callbacks: {
    async session({ token, session }) {
      if (token) {
        session.user.id = token.id;
        session.user.name = token.name;
        session.user.email = token.email;
        session.user.image = token.picture;
      }

      return session;
    },
    async jwt({ token, user }) {
      const [dbUser] = await db
        .select()
        .from(users)
        .where(eq(users.email, token.email || ""))
        .limit(1);

      if (!dbUser) {
        if (user) {
          token.id = user?.id;
        }
        return token;
      }

      return {
        id: dbUser.id,
        name: dbUser.name,
        email: dbUser.email,
        picture: dbUser.image,
      };
    },
  },
};
