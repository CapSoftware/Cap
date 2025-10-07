import crypto from "node:crypto";
import { serverEnv } from "@cap/env";
import { Organisation, User } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import type { NextAuthOptions } from "next-auth";
import { getServerSession as _getServerSession } from "next-auth";
import type { Adapter } from "next-auth/adapters";
import EmailProvider from "next-auth/providers/email";
import GoogleProvider from "next-auth/providers/google";
import type { Provider } from "next-auth/providers/index";
import WorkOSProvider from "next-auth/providers/workos";
import { dub } from "../dub.ts";
import { sendEmail } from "../emails/config.ts";
import { nanoId } from "../helpers.ts";
import { db } from "../index.ts";
import { organizationMembers, organizations, users } from "../schema.ts";
import { isEmailAllowedForSignup } from "./domain-utils.ts";
import { DrizzleAdapter } from "./drizzle-adapter.ts";

export const maxDuration = 120;

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
					async generateVerificationToken() {
						return crypto.randomInt(100000, 1000000).toString();
					},
					async sendVerificationRequest({ identifier, token }) {
						console.log("sendVerificationRequest");

						if (!serverEnv().RESEND_API_KEY) {
							console.log("\n");
							console.log(
								"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
							);
							console.log("🔐 VERIFICATION CODE (Development Mode)");
							console.log(
								"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
							);
							console.log(`📧 Email: ${identifier}`);
							console.log(`🔢 Code: ${token}`);
							console.log(`⏱  Expires in: 10 minutes`);
							console.log(
								"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
							);
							console.log("\n");
						} else {
							console.log({ identifier, token });
							const { OTPEmail } = await import("../emails/otp-email");
							const email = OTPEmail({ code: token, email: identifier });
							console.log({ email });
							await sendEmail({
								email: identifier,
								subject: `Your Cap Verification Code`,
								react: email,
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
			async signIn({ user, account, isNewUser }) {
				const [dbUser] = await db()
					.select()
					.from(users)
					.where(eq(users.id, User.UserId.make(user.id)))
					.limit(1);

				const needsOrganizationSetup =
					isNewUser ||
					!dbUser?.activeOrganizationId ||
					dbUser.activeOrganizationId === "";

				if (needsOrganizationSetup) {
					const { cookies } = await import("next/headers");
					const dubId = (await cookies()).get("dub_id")?.value;
					const dubPartnerData = (await cookies()).get(
						"dub_partner_data",
					)?.value;

					if (dubId && isNewUser) {
						try {
							console.log("Attempting to track lead with Dub...");
							const trackResult = await dub().track.lead({
								clickId: dubId,
								eventName: "Sign Up",
								externalId: user.id,
								customerName: user.name || undefined,
								customerEmail: user.email || undefined,
								customerAvatar: user.image || undefined,
							});

							console.log("Dub tracking successful:", trackResult);

							(await cookies()).delete("dub_id");
							if (dubPartnerData) {
								(await cookies()).delete("dub_partner_data");
							}
						} catch (error) {
							console.error("Failed to track lead with Dub:", error);
							console.error("Error details:", JSON.stringify(error, null, 2));
						}
					} else if (!isNewUser) {
						console.log(
							"Guest checkout user signing in for the first time - setting up organization",
						);
					}

					const organizationId = Organisation.OrganisationId.make(nanoId());

					await db()
						.insert(organizations)
						.values({
							id: organizationId,
							name: "My Organization",
							ownerId: User.UserId.make(user.id),
						});

					await db()
						.insert(organizationMembers)
						.values({
							id: nanoId(),
							userId: User.UserId.make(user.id),
							organizationId: organizationId,
							role: "owner",
						});

					await db()
						.update(users)
						.set({ activeOrganizationId: organizationId })
						.where(eq(users.id, User.UserId.make(user.id)));
				}
			},
		},
		callbacks: {
			async signIn({ user, email, credentials }) {
				const allowedDomains = serverEnv().CAP_ALLOWED_SIGNUP_DOMAINS;
				if (!allowedDomains) return true;

				// Get email from either user object (OAuth) or email parameter (email provider)
				const userEmail =
					user?.email ||
					(typeof email === "string"
						? email
						: typeof credentials?.email === "string"
							? credentials.email
							: null);
				if (!userEmail || typeof userEmail !== "string") return true;

				const [existingUser] = await db()
					.select()
					.from(users)
					.where(eq(users.email, userEmail))
					.limit(1);

				// Only apply domain restrictions for new users, existing ones can always sign in
				if (
					!existingUser &&
					!isEmailAllowedForSignup(userEmail, allowedDomains)
				) {
					console.warn(`Signup blocked for email domain: ${userEmail}`);
					return false;
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

export const getServerSession = () => _getServerSession(authOptions());
