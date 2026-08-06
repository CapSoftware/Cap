import crypto from "node:crypto";
import { serverEnv } from "@cap/env";
import { User } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import type { NextAuthOptions } from "next-auth";
import { getServerSession as _getServerSession } from "next-auth";
import type { Adapter } from "next-auth/adapters";
import { decode, type JWT, type JWTDecodeParams } from "next-auth/jwt";
import AppleProvider from "next-auth/providers/apple";
import CredentialsProvider from "next-auth/providers/credentials";
import EmailProvider from "next-auth/providers/email";
import GoogleProvider from "next-auth/providers/google";
import type { Provider } from "next-auth/providers/index";
import WorkOSProvider from "next-auth/providers/workos";
import { sendEmail } from "../emails/config.ts";
import { db } from "../index.ts";
import { users } from "../schema.ts";
import { isEmailAllowedForSignup } from "./domain-utils.ts";
import { DrizzleAdapter } from "./drizzle-adapter.ts";

export const maxDuration = 120;

const OTP_CODE_MAX_AGE_SECONDS = 10 * 60;

export async function decodeSessionToken(
	params: JWTDecodeParams,
): Promise<JWT | null> {
	const token = await decode(params);
	if (!token) return null;

	const userId = typeof token.id === "string" ? token.id : null;
	if (!userId) return token;

	const [user] = await db()
		.select({ authSessionVersion: users.authSessionVersion })
		.from(users)
		.where(eq(users.id, User.UserId.make(userId)))
		.limit(1);

	if (!user) return null;

	const sessionVersion =
		typeof token.sessionVersion === "number" ? token.sessionVersion : 0;

	if (sessionVersion !== user.authSessionVersion) return null;

	return token;
}

export const authOptions = (): NextAuthOptions => {
	let _adapter: Adapter | undefined;
	let _providers: Provider[] | undefined;

	return {
		get adapter() {
			if (_adapter) return _adapter;
			_adapter = DrizzleAdapter(db());
			return _adapter;
		},
		debug: process.env.NODE_ENV !== "production",
		session: {
			strategy: "jwt",
		},
		jwt: {
			decode: decodeSessionToken,
		},
		get secret() {
			return serverEnv().NEXTAUTH_SECRET;
		},
		pages: {
			signIn: "/login",
		},
		get providers() {
			if (_providers) return _providers;
			const appleClientId = serverEnv().APPLE_CLIENT_ID;
			const appleClientSecret = serverEnv().APPLE_CLIENT_SECRET;
			if (
				serverEnv().TRUSTED_PROXY_AUTH_HEADER &&
				serverEnv().TRUSTED_PROXY_AUTH_EMAIL
			) {
				console.warn(
					"[auth] trusted-proxy sign-in is ENABLED. Only run this behind a reverse proxy that strips client-sent copies of the trust header, or a login bypass is possible.",
				);
			}
			_providers = [
				...(appleClientId && appleClientSecret
					? [
							AppleProvider({
								clientId: appleClientId,
								clientSecret: appleClientSecret,
							}),
						]
					: []),
				GoogleProvider({
					clientId: serverEnv().GOOGLE_CLIENT_ID as string,
					clientSecret: serverEnv().GOOGLE_CLIENT_SECRET as string,
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
				...(serverEnv().TRUSTED_PROXY_AUTH_HEADER &&
				serverEnv().TRUSTED_PROXY_AUTH_EMAIL
					? [
							CredentialsProvider({
								id: "trusted-proxy",
								name: "Reverse Proxy",
								credentials: {},
								// SECURITY: this header is trusted ONLY because the operator
								// opted in via env, asserting Cap runs behind a reverse proxy
								// that strips any client-sent copy of the header and sets it
								// only on authenticated requests. Never enable without such a
								// proxy — it would be a login bypass. Fails closed below.
								async authorize(_credentials, req) {
									const env = serverEnv();
									const header = env.TRUSTED_PROXY_AUTH_HEADER!.toLowerCase();
									// The router is the sole authority for this header (it strips
									// any client-sent copy), so its presence means the request was
									// owner-authenticated. Fail closed on anything else.
									if (req?.headers?.[header] !== "true") return null;

									// Defense-in-depth: when a shared secret is configured, the proxy
									// must also send it, so a request that reaches Cap outside the
									// proxy can't spoof the header. Constant-time and length-blind.
									const secret = env.TRUSTED_PROXY_AUTH_SECRET;
									if (secret) {
										const provided =
											req?.headers?.["x-trusted-proxy-secret"] ?? "";
										const digest = (s: string) =>
											crypto.createHash("sha256").update(s).digest();
										if (!crypto.timingSafeEqual(digest(provided), digest(secret)))
											return null;
									}

									const email = env.TRUSTED_PROXY_AUTH_EMAIL!.toLowerCase();
									const [user] = await db()
										.select({
											id: users.id,
											email: users.email,
											name: users.name,
											image: users.image,
										})
										.from(users)
										.where(eq(users.email, email))
										.limit(1);
									if (!user) return null;

									return {
										id: user.id,
										email: user.email,
										name: user.name,
										image: user.image,
									};
								},
							}),
						]
					: []),
				EmailProvider({
					// next-auth defaults to 24h, but the code is 6 digits and the
					// verify path has no attempt limiting, so a day-long window is a
					// practical brute-force target. The OTP email and the dev console
					// have always told users 10 minutes; this makes that true.
					maxAge: OTP_CODE_MAX_AGE_SECONDS,
					async generateVerificationToken() {
						return crypto.randomInt(100000, 1000000).toString();
					},
					async sendVerificationRequest({ identifier, token }) {
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
							console.log(
								`⏱  Expires in: ${OTP_CODE_MAX_AGE_SECONDS / 60} minutes`,
							);
							console.log(
								"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
							);
							console.log("\n");
						} else {
							const { OTPEmail } = await import("../emails/otp-email");
							const email = OTPEmail({ code: token, email: identifier });
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
			callbackUrl: {
				name: "next-auth.callback-url",
				options: {
					httpOnly: true,
					sameSite: "none",
					path: "/",
					secure: true,
				},
			},
			pkceCodeVerifier: {
				name: "next-auth.pkce.code_verifier",
				options: {
					httpOnly: true,
					sameSite: "none",
					path: "/",
					secure: true,
					maxAge: 60 * 15,
				},
			},
		},
		callbacks: {
			async signIn({ user, email, credentials }) {
				const allowedDomains = serverEnv().CAP_ALLOWED_SIGNUP_DOMAINS;
				if (!allowedDomains) return true;

				const rawEmail =
					user?.email ||
					(typeof email === "string"
						? email
						: typeof credentials?.email === "string"
							? credentials.email
							: null);
				if (!rawEmail || typeof rawEmail !== "string") return true;
				const userEmail = rawEmail.toLowerCase();

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

				if (token?.id && typeof token.id === "string") {
					(session.user as { id: string }).id = token.id;
					session.user.name = token.name ?? null;
					session.user.email = token.email ?? null;
					session.user.image = token.picture ?? null;
				}

				return session;
			},
			async jwt({ token, user }) {
				if (user || !token.id) {
					const [dbUser] = await db()
						.select({
							id: users.id,
							name: users.name,
							lastName: users.lastName,
							email: users.email,
							image: users.image,
							authSessionVersion: users.authSessionVersion,
						})
						.from(users)
						.where(eq(users.email, (token.email || "").toLowerCase()))
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
						sessionVersion: dbUser.authSessionVersion,
					};
				}

				return token;
			},
		},
	};
};

export const getServerSession = () => _getServerSession(authOptions());
