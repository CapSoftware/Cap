import { eq } from "drizzle-orm";
import { DrizzleAdapter } from "./drizzle-adapter";
import { db } from "../";
import { users, organizations, organizationMembers } from "../schema";
import EmailProvider from "next-auth/providers/email";
import GoogleProvider from "next-auth/providers/google";
import type { NextAuthOptions } from "next-auth";
import { sendEmail } from "../emails/config";
import { LoginLink } from "../emails/login-link";
import { nanoId } from "../helpers";
import WorkOSProvider from "next-auth/providers/workos";
import { NODE_ENV, serverEnv } from "@cap/env";
import type { Adapter } from "next-auth/adapters";
import type { Provider } from "next-auth/providers/index";

export const config = {
  maxDuration: 120,
};

export const authOptions = (): NextAuthOptions => {
  let _adapter: Adapter | undefined;
  let _providers: Provider[] | undefined;

  return {
    get adapter() {
      if (_adapter) return _adapter;
      _adapter = DrizzleAdapter(db());
      return _adapter;
    },
    debug: true,
    session: {
      strategy: "jwt",
    },
    get secret() {
      return serverEnv().NEXTAUTH_SECRET;
    },
    pages: {
      signIn: "/login",
    },
    get providers() {
      if (_providers) return _providers;
      _providers = [
        GoogleProvider({
          clientId: serverEnv().GOOGLE_CLIENT_ID!,
          clientSecret: serverEnv().GOOGLE_CLIENT_SECRET!,
          authorization: {
            params: {
              scope: [
                "https://www.googleapis.com/auth/userinfo.email",
                "https://www.googleapis.com/auth/userinfo.profile",
              ].join(" "),
              prompt: "select_account",
            },
          },
        }),
        WorkOSProvider({
          clientId: serverEnv().WORKOS_CLIENT_ID as string,
          clientSecret: serverEnv().WORKOS_API_KEY as string,
          profile(profile) {
            return {
              id: profile.id,
              name: profile.first_name
                ? `${profile.first_name} ${profile.last_name || ""}`
                : profile.email?.split("@")[0] || profile.id,
              email: profile.email,
              image: profile.profile_picture_url,
            };
          },
        }),
        EmailProvider({
          sendVerificationRequest({ identifier, url }) {
            if (
              NODE_ENV === "development" ||
              !serverEnv().RESEND_API_KEY ||
              serverEnv().RESEND_API_KEY === ""
            ) {
              console.log(`Login link: ${url}`);
            } else {
              sendEmail({
                email: identifier,
                subject: `Your Cap Login Link`,
                react: LoginLink({ url, email: identifier }),
              });
            }
          },
        }),
      ];

      return _providers;
    },
    cookies: {
      sessionToken: {
        name: `next-auth.session-token`,
        options: {
          httpOnly: true,
          sameSite: "none",
          path: "/",
          secure: true,
        },
      },
    },
    events: {
      async signIn({ user, isNewUser }) {
        if (isNewUser) {
          const organizationId = nanoId();

          await db().insert(organizations).values({
            id: organizationId,
            name: "My Organization",
            ownerId: user.id,
          });

          await db().insert(organizationMembers).values({
            id: nanoId(),
            userId: user.id,
            organizationId: organizationId,
            role: "owner",
          });

          await db()
            .update(users)
            .set({ activeOrganizationId: organizationId })
            .where(eq(users.id, user.id));
        }
      },
    },
    callbacks: {
      async session({ token, session }) {
        if (!session.user) return session;

        if (token) {
          session.user.id = token.id;
          session.user.name = token.name;
          session.user.email = token.email;
          session.user.image = token.picture;
        }

        return session;
      },
      async jwt({ token, user }) {
        const [dbUser] = await db()
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
          lastName: dbUser.lastName,
          email: dbUser.email,
          picture: dbUser.image,
        };
      },
    },
  };
};
