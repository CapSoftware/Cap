import { eq } from "drizzle-orm";
import { DrizzleAdapter } from "./drizzle-adapter";
import type { NextAuthOptions } from "next-auth";
import EmailProvider from "next-auth/providers/email";
import GoogleProvider from "next-auth/providers/google";
import WorkOSProvider from "next-auth/providers/workos";
import CredentialsProvider from "next-auth/providers/credentials";
import { NODE_ENV, serverEnv } from "@cap/env";
import type { Adapter } from "next-auth/adapters";
import type { Provider } from "next-auth/providers/index";

import { db } from "../";
import { users, organizations, organizationMembers } from "../schema";
import { nanoId } from "../helpers";
import { sendEmail } from "../emails/config";
import { LoginLink } from "../emails/login-link";
import { OtpCode } from "../emails/otp-code";
import { createOTP, verifyOTP } from "./otp";

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
      maxAge: 30 * 24 * 60 * 60,
    },
    jwt: {
      maxAge: 30 * 24 * 60 * 60,
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
        CredentialsProvider({
          id: "otp",
          name: "OTP",
          credentials: {
            email: { label: "Email", type: "email" },
            otp: { label: "OTP", type: "text" },
          },
          async authorize(credentials) {
            if (!credentials?.email || !credentials?.otp) {
              return null;
            }

            const isValid = await verifyOTP(credentials.email, credentials.otp);
            if (!isValid) {
              return null;
            }

            const [existingUser] = await db()
              .select()
              .from(users)
              .where(eq(users.email, credentials.email))
              .limit(1);

            if (existingUser) {
              return {
                id: existingUser.id,
                email: existingUser.email,
                name: existingUser.name,
                image: existingUser.image,
              };
            }

            const newUserId = nanoId();
            await db().insert(users).values({
              id: newUserId,
              email: credentials.email,
              emailVerified: new Date(),
              activeOrganizationId: "",
            });

            return {
              id: newUserId,
              email: credentials.email,
              name: null,
              image: null,
            };
          },
        }),
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
          async sendVerificationRequest({ identifier, url }) {
            console.log("sendVerificationRequest");
            try {
              const otpCode = await createOTP(identifier);

              if (!serverEnv().RESEND_API_KEY) {
                console.log(`Login OTP code for ${identifier}: ${otpCode}`);
              } else {
                console.log({ identifier, otpCode });
                const email = OtpCode({ code: otpCode, email: identifier });
                await sendEmail({
                  email: identifier,
                  subject: `Your Cap verification code: ${otpCode}`,
                  react: email,
                });
              }
            } catch (error) {
              console.error("Failed to create OTP:", error);
              throw new Error(
                error instanceof Error
                  ? error.message
                  : "Failed to send verification code"
              );
            }
          },
          maxAge: 10 * 60,
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
          maxAge: 30 * 24 * 60 * 60,
        },
      },
    },
    events: {
      async signIn({ user, account, isNewUser }) {
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
      async signIn({ user, account }) {
        if (account?.provider === "otp" && user) {
          const [existingUser] = await db()
            .select()
            .from(users)
            .where(eq(users.id, user.id))
            .limit(1);

          if (existingUser && !existingUser.activeOrganizationId) {
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
        }
        return true;
      },
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
