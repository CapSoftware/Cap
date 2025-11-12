import crypto from "node:crypto";
import { serverEnv } from "@cap/env";
import { Organisation, User } from "@cap/web-domain";
import {eq, and} from "drizzle-orm";
import type { NextAuthOptions } from "next-auth";
import { getServerSession as _getServerSession } from "next-auth";
import type { Adapter } from "next-auth/adapters";
import EmailProvider from "next-auth/providers/email";
import GoogleProvider from "next-auth/providers/google";
import type { Provider } from "next-auth/providers/index";
import WorkOSProvider from "next-auth/providers/workos";
import CredentialsProvider from "next-auth/providers/credentials";
import { dub } from "../dub.ts";
import { sendEmail } from "../emails/config.ts";
import { nanoId } from "../helpers.ts";
import { db } from "../index.ts";
import {organizationMembers, organizations, users, verificationTokens} from "../schema.ts";
import { isEmailAllowedForSignup } from "./domain-utils.ts";
import { DrizzleAdapter } from "./drizzle-adapter.ts";
import { verifyPassword } from "@cap/database/crypto";

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
				CredentialsProvider({
					name: "Credentials",
					credentials: {
						email: { label: "Email", type: "text", placeholder: "you@domain.com" },
						password: { label: "Password", type: "password" },
						otp_token: { label: "OTP Token", type: "text" },
					},
					async authorize(credentials) {
						try {
							if (!credentials?.email) {
								throw new Error("Missing email");
							}

							const [user] = await db()
								.select()
								.from(users)
								.where(eq(users.email, credentials.email))
								.limit(1);

							if (!user) throw new Error("We couldn’t find your account. Try signing up!");

							// If otp_token is provided, verify it instead of password
							// This is used for completing signup after OTP verification
							if (credentials.otp_token) {
								const authTokenIdentifier = `auth-token:${credentials.email}`;
								const [tokenRecord] = await db()
									.select()
									.from(verificationTokens)
									.where(
										and(
											eq(
												verificationTokens.identifier,
												authTokenIdentifier,
											),
											eq(verificationTokens.token, credentials.otp_token),
										),
									)
									.limit(1);

								if (!tokenRecord) {
									throw new Error("Invalid or expired authentication token");
								}

								if (new Date(tokenRecord.expires) < new Date()) {
									throw new Error("Authentication token expired");
								}

								// Require email verification
								if (!user.emailVerified) {
									throw new Error("Please verify your email before logging in.");
								}

								// Delete the one-time token after use
								await db()
									.delete(verificationTokens)
									.where(eq(verificationTokens.identifier, authTokenIdentifier));

								return {
									id: user.id,
									name: user.name,
									email: user.email,
									image: user.image,
								};
							}

							// Normal password authentication
							if (!credentials?.password || user.password === null) {
								throw new Error("Invalid email or password");
							}
							// Require email verification before login
							//navigation to verify-otp and sending otp handled at client side
							if (!user.emailVerified) {
								throw new Error("Please verify your email before logging in.");
							}

							const isValid = await verifyPassword(
								user.password,
								credentials.password,
							);
							if (!isValid) throw new Error("Invalid email or password");

							return {
								id: user.id,
								name: user.name,
								email: user.email,
								image: user.image,
							};
						} catch (err) {
							console.error("Credential authorize error:", err);
							throw err;
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
