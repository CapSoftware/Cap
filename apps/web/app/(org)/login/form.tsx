"use client";

import { Button, Input, LogoBadge } from "@cap/ui";
import { Organisation } from "@cap/web-domain";
import {
	faArrowLeft,
	faEnvelope,
	faExclamationCircle,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { AnimatePresence, motion } from "framer-motion";
import Cookies from "js-cookie";
import { LucideArrowUpRight } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import { Suspense, useEffect, useState } from "react";
import { toast } from "sonner";
import { getOrganizationSSOData } from "@/actions/organization/get-organization-sso-data";
import { trackEvent } from "@/app/utils/analytics";
import { usePublicEnv } from "@/utils/public-env";

const MotionInput = motion(Input);
const MotionLogoBadge = motion(LogoBadge);
const MotionLink = motion(Link);
const MotionButton = motion(Button);

export function LoginForm() {
	const searchParams = useSearchParams();
	const router = useRouter();
	const next = searchParams?.get("next") || searchParams?.get("callbackUrl");
	const [email, setEmail] = useState("");
	const [loading, setLoading] = useState(false);
	const [emailSent, setEmailSent] = useState(false);
	const [oauthError, setOauthError] = useState(false);
	const [showOrgInput, setShowOrgInput] = useState(false);
	const [organizationId, setOrganizationId] = useState("");
	const [organizationName, setOrganizationName] = useState<string | null>(null);
	const [lastEmailSentTime, setLastEmailSentTime] = useState<number | null>(
		null,
	);
	const theme = Cookies.get("theme") || "light";

	useEffect(() => {
		theme === "dark"
			? (document.body.className = "dark")
			: (document.body.className = "light");
		//remove the dark mode when we leave the dashboard
		return () => {
			document.body.className = "light";
		};
	}, [theme]);

	useEffect(() => {
		const error = searchParams?.get("error");
		const errorDesc = searchParams?.get("error_description");

		const handleErrors = () => {
			if (error === "OAuthAccountNotLinked" && !errorDesc) {
				setOauthError(true);
				return toast.error(
					"This email is already associated with a different sign-in method",
				);
			} else if (
				error === "profile_not_allowed_outside_organization" &&
				!errorDesc
			) {
				return toast.error(
					"Your email domain is not authorized for SSO access. Please use your work email or contact your administrator.",
				);
			} else if (error && errorDesc) {
				return toast.error(errorDesc);
			}
		};
		handleErrors();
	}, [searchParams]);

	useEffect(() => {
		const pendingPriceId = localStorage.getItem("pendingPriceId");
		const pendingQuantity = localStorage.getItem("pendingQuantity") ?? "1";
		if (emailSent && pendingPriceId) {
			localStorage.removeItem("pendingPriceId");
			localStorage.removeItem("pendingQuantity");

			// Wait a bit to ensure the user is created
			setTimeout(async () => {
				const response = await fetch(`/api/settings/billing/subscribe`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						priceId: pendingPriceId,
						quantity: parseInt(pendingQuantity, 10),
					}),
				});
				const data = await response.json();

				if (data.url) {
					window.location.href = data.url;
				}
			}, 2000);
		}
	}, [emailSent]);

	const handleGoogleSignIn = () => {
		trackEvent("auth_started", { method: "google", is_signup: true });
		signIn("google", {
			...(next && next.length > 0 ? { callbackUrl: next } : {}),
		});
	};

	const handleOrganizationLookup = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!organizationId) {
			toast.error("Please enter an organization ID");
			return;
		}

		try {
			const data = await getOrganizationSSOData(
				Organisation.OrganisationId.make(organizationId),
			);
			setOrganizationName(data.name);

			signIn("workos", {
				...(next && next.length > 0 ? { callbackUrl: next } : {}),
			}, {
				organization: data.organizationId,
				connection: data.connectionId,
			});
		} catch (error) {
			console.error("Lookup Error:", error);
			toast.error("Organization not found or SSO not configured");
		}
	};

	return (
		<motion.div
			layout
			transition={{
				layout: { duration: 0.3, ease: "easeInOut" },
				height: { duration: 0.3, ease: "easeInOut" },
			}}
			className="overflow-hidden relative w-[calc(100%-5%)] p-[28px] max-w-[432px] bg-gray-3 border border-gray-5 rounded-2xl"
		>
			<motion.div
				layout="position"
				key="back-button"
				initial={{ opacity: 0, display: "none" }}
				animate={{
					opacity: showOrgInput ? 1 : 0,
					display: showOrgInput ? "flex" : "none",
					transition: { duration: 0.1, delay: 0.2 },
				}}
				onClick={() => setShowOrgInput(false)}
				className="absolute overflow-hidden top-5 rounded-full left-5 z-20 hover:bg-gray-1 gap-2 items-center py-1.5 px-3 text-gray-12 bg-transparent border border-gray-4 transition-colors duration-300 cursor-pointer"
			>
				<FontAwesomeIcon className="w-2" icon={faArrowLeft} />
				<motion.p layout="position" className="text-xs text-inherit">
					Back
				</motion.p>
			</motion.div>
			<MotionLink layout="position" className="flex mx-auto size-fit" href="/">
				<MotionLogoBadge layout="position" className="size-12" />
			</MotionLink>
			<motion.div
				layout="position"
				className="flex flex-col justify-center items-center my-7 text-left"
			>
				<motion.h1
					key="title"
					layout="position"
					className="text-2xl font-semibold text-gray-12"
				>
					Sign in to Cap
				</motion.h1>
				<motion.p
					key="subtitle"
					layout="position"
					className="text-[16px] text-gray-10"
				>
					Beautiful screen recordings, owned by you.
				</motion.p>
			</motion.div>
			<motion.div layout="position" className="flex flex-col space-y-3">
				<Suspense
					fallback={
						<>
							<Button disabled={true} variant="primary" />
							<Button disabled={true} variant="destructive" />
							<div className="mx-auto w-3/4 h-5 rounded-lg bg-gray-1" />
						</>
					}
				>
					<motion.div layout className="flex flex-col space-y-3">
						<AnimatePresence mode="wait" initial={false}>
							<motion.div
								key={showOrgInput ? "sso-wrapper" : "email-wrapper"}
								layout
								initial={{ height: 0, opacity: 0 }}
								animate={{ height: "auto", opacity: 1 }}
								exit={{ height: 0, opacity: 0 }}
								transition={{
									duration: 0.25,
									ease: "easeInOut",
									opacity: { delay: 0.05 },
								}}
								className="px-1"
							>
								{showOrgInput ? (
									<motion.div
										key="sso"
										layout
										className="min-w-fit"
										initial={{ opacity: 0, y: 10 }}
										animate={{ opacity: 1, y: 0, transition: { delay: 0.1 } }}
										exit={{ opacity: 0, y: -10, transition: { duration: 0.1 } }}
										transition={{ duration: 0.2, ease: "easeInOut" }}
									>
										<LoginWithSSO
											handleOrganizationLookup={handleOrganizationLookup}
											organizationId={organizationId}
											setOrganizationId={setOrganizationId}
											organizationName={organizationName}
										/>
									</motion.div>
								) : (
									<motion.form
										key="email"
										layout
										initial={{ opacity: 0, y: 10 }}
										animate={{
											opacity: 1,
											y: 0,
											transition: { duration: 0.1 },
										}}
										exit={{
											opacity: 0,
											y: -10,
											transition: { duration: 0.15 },
										}}
										transition={{
											duration: 0.2,
											ease: "easeInOut",
											opacity: { delay: 0.05 },
										}}
										onSubmit={async (e) => {
											e.preventDefault();
											if (!email) return;

											// Check if we're rate limited on the client side
											if (lastEmailSentTime) {
												const timeSinceLastRequest =
													Date.now() - lastEmailSentTime;
												const waitTime = 30000; // 30 seconds
												if (timeSinceLastRequest < waitTime) {
													const remainingSeconds = Math.ceil(
														(waitTime - timeSinceLastRequest) / 1000,
													);
													toast.error(
														`Please wait ${remainingSeconds} seconds before requesting a new code`,
													);
													return;
												}
											}

											setLoading(true);
											trackEvent("auth_started", {
												method: "email",
												is_signup: !oauthError,
											});
											const normalizedEmail = email.trim().toLowerCase();
											signIn("email", {
												email: normalizedEmail,
												redirect: false,
												...(next && next.length > 0
													? { callbackUrl: next }
													: {}),
											})
												.then((res) => {
													setLoading(false);

													if (res?.ok && !res?.error) {
														setEmailSent(true);
														setLastEmailSentTime(Date.now());
														trackEvent("auth_email_sent", {
															email_domain: normalizedEmail.split("@")[1],
														});
														const params = new URLSearchParams({
															email: normalizedEmail,
															...(next && { next }),
															lastSent: Date.now().toString(),
														});
														router.push(`/verify-otp?${params.toString()}`);
													} else {
														// NextAuth always returns "EmailSignin" for all email provider errors
														// Since we already check rate limiting on the client side before sending,
														// if we get an error here, it's likely rate limiting from the server
														toast.error(
															"Please wait 30 seconds before requesting a new code",
														);
													}
												})
												.catch((_error) => {
													setEmailSent(false);
													setLoading(false);
													// Catch block is rarely triggered with NextAuth
													toast.error("Error sending email - try again?");
												});
										}}
										className="flex flex-col space-y-3"
									>
										<NormalLogin
											setShowOrgInput={setShowOrgInput}
											email={email}
											emailSent={emailSent}
											setEmail={setEmail}
											loading={loading}
											oauthError={oauthError}
											handleGoogleSignIn={handleGoogleSignIn}
										/>
									</motion.form>
								)}
							</motion.div>
						</AnimatePresence>
						<motion.p
							layout="position"
							className="pt-3 text-xs text-center text-gray-9"
						>
							By typing your email and clicking continue, you acknowledge that
							you have both read and agree to Cap's{" "}
							<Link
								href="/terms"
								target="_blank"
								className="text-xs font-semibold text-gray-12 hover:text-blue-300"
							>
								Terms of Service
							</Link>{" "}
							and{" "}
							<Link
								href="/privacy"
								target="_blank"
								className="text-xs font-semibold text-gray-12 hover:text-blue-300"
							>
								Privacy Policy
							</Link>
							.
						</motion.p>
					</motion.div>
				</Suspense>
			</motion.div>
		</motion.div>
	);
}

const LoginWithSSO = ({
	handleOrganizationLookup,
	organizationId,
	setOrganizationId,
	organizationName,
}: {
	handleOrganizationLookup: (e: React.FormEvent) => void;
	organizationId: string;
	setOrganizationId: (organizationId: string) => void;
	organizationName: string | null;
}) => {
	return (
		<motion.form
			layout
			onSubmit={handleOrganizationLookup}
			className="relative space-y-2"
		>
			<MotionInput
				id="organizationId"
				placeholder="Enter your Organization ID..."
				value={organizationId}
				onChange={(e) => setOrganizationId(e.target.value)}
				className="w-full max-w-full"
			/>
			{organizationName && (
				<p className="text-sm text-gray-1">Signing in to: {organizationName}</p>
			)}
			<div>
				<Button type="submit" variant="dark" className="w-full max-w-full">
					Continue with SSO
				</Button>
			</div>
		</motion.form>
	);
};

const NormalLogin = ({
	setShowOrgInput,
	email,
	emailSent,
	setEmail,
	loading,
	oauthError,
	handleGoogleSignIn,
}: {
	setShowOrgInput: (show: boolean) => void;
	email: string;
	emailSent: boolean;
	setEmail: (email: string) => void;
	loading: boolean;
	oauthError: boolean;
	handleGoogleSignIn: () => void;
}) => {
	const publicEnv = usePublicEnv();

	return (
		<motion.div>
			<motion.div layout className="flex flex-col space-y-3">
				<MotionInput
					id="email"
					name="email"
					autoFocus
					type="email"
					placeholder={emailSent ? "" : "tim@apple.com"}
					autoComplete="email"
					required
					value={email}
					disabled={emailSent || loading}
					onChange={(e) => {
						setEmail(e.target.value.toLowerCase());
					}}
				/>
				<MotionButton
					variant="dark"
					type="submit"
					disabled={loading || emailSent}
					icon={<FontAwesomeIcon className="mr-1 size-4" icon={faEnvelope} />}
				>
					Login with email
				</MotionButton>
				{/* {NODE_ENV === "development" && (
                  <div className="flex justify-center items-center px-6 py-3 mt-3 bg-red-600 rounded-xl">
                    <p className="text-lg text-white">
                      <span className="font-medium text-white">
                        Development mode:
                      </span>{" "}
                      Auth URL will be logged to your dev console.
                    </p>
                  </div>
                )} */}
			</motion.div>
			<motion.p
				layout="position"
				className="mt-3 mb-2 text-xs text-center text-gray-9"
			>
				Don't have an account?{" "}
				<Link
					href="/signup"
					className="text-xs font-semibold text-blue-9 hover:text-blue-8"
				>
					Sign up here
				</Link>
			</motion.p>

			{(publicEnv.googleAuthAvailable || publicEnv.workosAuthAvailable) && (
				<>
					<div className="flex gap-4 items-center mt-4 mb-4">
						<span className="flex-1 h-px bg-gray-5" />
						<p className="text-sm text-center text-gray-10">OR</p>
						<span className="flex-1 h-px bg-gray-5" />
					</div>
					<motion.div
						layout
						className="flex flex-col gap-3 justify-center items-center"
					>
						{publicEnv.googleAuthAvailable && !oauthError && (
							<MotionButton
								variant="gray"
								type="button"
								className="flex gap-2 justify-center items-center w-full text-sm"
								onClick={handleGoogleSignIn}
								disabled={loading || emailSent}
							>
								<Image src="/google.svg" alt="Google" width={16} height={16} />
								Login with Google
							</MotionButton>
						)}

						{oauthError && (
							<div className="flex gap-3 items-center p-3 bg-red-400 rounded-xl border border-red-600">
								<FontAwesomeIcon
									className="text-gray-50 size-8"
									icon={faExclamationCircle}
								/>
								<p className="text-xs leading-5 text-gray-50">
									It looks like you've previously used this email to sign up via
									email login. Please enter your email.
								</p>
							</div>
						)}
						{publicEnv.workosAuthAvailable && (
							<MotionButton
								variant="gray"
								type="button"
								className="w-full"
								layout
								onClick={() => setShowOrgInput(true)}
								disabled={loading || emailSent}
							>
								<LucideArrowUpRight size={20} />
								Login with SAML SSO
							</MotionButton>
						)}
					</motion.div>
				</>
			)}
		</motion.div>
	);
};
