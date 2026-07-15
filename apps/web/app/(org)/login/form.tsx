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
import {
	Suspense,
	useCallback,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import { getOrganizationSSOData } from "@/actions/organization/get-organization-sso-data";
import { trackEvent } from "@/app/utils/analytics";
import { usePublicEnv } from "@/utils/public-env";
import { getEmailCodeCooldownSeconds, requestEmailCode } from "../auth-email";
import { getSafeNextPath } from "../safe-next";

const MotionInput = motion(Input);
const MotionLogoBadge = motion(LogoBadge);
const MotionLink = motion(Link);
const MotionButton = motion(Button);

export function LoginForm() {
	const searchParams = useSearchParams();
	const router = useRouter();
	const next = searchParams?.get("next");
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
	const mobileGoogleSignInStarted = useRef(false);
	const mobileWorkosSignInStarted = useRef(false);
	const loginFormMounted = useRef(false);
	const theme = Cookies.get("theme") || "light";
	const getNextPath = useCallback(
		() => (next ? getSafeNextPath(next, window.location.origin) : null),
		[next],
	);

	useEffect(() => {
		loginFormMounted.current = true;
		return () => {
			loginFormMounted.current = false;
		};
	}, []);

	useEffect(() => {
		document.body.className = theme === "dark" ? "dark" : "light";
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
				return toast.error("此邮箱已关联其他登录方式");
			} else if (
				error === "profile_not_allowed_outside_organization" &&
				!errorDesc
			) {
				return toast.error(
					"你的邮箱域名未获 SSO 访问授权。请使用工作邮箱或联系管理员。",
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

	const handleGoogleSignIn = useCallback(() => {
		const nextPath = getNextPath();
		trackEvent("auth_started", {
			method: "google",
			is_signup: false,
			auth_surface: "login",
		});
		signIn("google", {
			...(nextPath ? { callbackUrl: nextPath } : {}),
		});
	}, [getNextPath]);

	const handleWorkosSignIn = useCallback(
		async (orgId: string) => {
			const nextPath = getNextPath();
			const data = await getOrganizationSSOData(
				Organisation.OrganisationId.make(orgId),
			);
			setOrganizationName(data.name);

			signIn("workos", nextPath ? { callbackUrl: nextPath } : undefined, {
				organization: data.organizationId,
				connection: data.connectionId,
			});
		},
		[getNextPath],
	);

	useEffect(() => {
		if (searchParams?.get("mobileProvider") === "google") {
			if (mobileGoogleSignInStarted.current) return;
			mobileGoogleSignInStarted.current = true;
			handleGoogleSignIn();
			return;
		}

		if (searchParams?.get("mobileProvider") !== "workos") return;
		const mobileOrganizationId = searchParams.get("organizationId");
		if (!mobileOrganizationId) {
			setShowOrgInput(true);
			return;
		}
		if (mobileWorkosSignInStarted.current) return;
		mobileWorkosSignInStarted.current = true;

		handleWorkosSignIn(mobileOrganizationId).catch(() => {
			if (!loginFormMounted.current) return;
			setOrganizationId(mobileOrganizationId);
			setShowOrgInput(true);
			toast.error("找不到组织，或组织尚未配置 SSO");
		});
	}, [handleGoogleSignIn, handleWorkosSignIn, searchParams]);

	const handleOrganizationLookup = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!organizationId) {
			toast.error("请输入组织 ID");
			return;
		}

		try {
			await handleWorkosSignIn(organizationId);
		} catch (error) {
			console.error("Lookup Error:", error);
			toast.error("找不到组织，或组织尚未配置 SSO");
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
					返回
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
					登录 Cap
				</motion.h1>
				<motion.p
					key="subtitle"
					layout="position"
					className="text-[16px] text-gray-10"
				>
					精美的屏幕录制，完全由你掌控。
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
										noValidate
										onSubmit={async (e) => {
											e.preventDefault();

											const remainingSeconds =
												getEmailCodeCooldownSeconds(lastEmailSentTime);
											if (remainingSeconds > 0) {
												toast.error(
													`请等待 ${remainingSeconds} 秒后再请求新验证码。`,
												);
												return;
											}

											setLoading(true);
											try {
												const nextPath = getNextPath();
												const normalizedEmail = await requestEmailCode({
													email,
													next: nextPath,
													isSignup: false,
													authSurface: "login",
												});
												if (!normalizedEmail) return;

												const sentAt = Date.now();
												setEmailSent(true);
												setLastEmailSentTime(sentAt);
												const params = new URLSearchParams({
													email: normalizedEmail,
													...(nextPath && { next: nextPath }),
													lastSent: sentAt.toString(),
												});
												router.push(`/verify-otp?${params.toString()}`);
											} catch {
												setEmailSent(false);
												toast.error(
													"登录耗时超出预期。请检查网络连接或浏览器扩展后重试。",
												);
											} finally {
												setLoading(false);
											}
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
							输入邮箱并点击继续，即表示你已阅读并同意 Cap 的{" "}
							<Link
								href="/terms"
								target="_blank"
								className="text-xs font-semibold text-gray-12 hover:text-blue-300"
							>
								服务条款
							</Link>{" "}
							和{" "}
							<Link
								href="/privacy"
								target="_blank"
								className="text-xs font-semibold text-gray-12 hover:text-blue-300"
							>
								隐私政策
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
	const organizationIdInputId = useId();

	return (
		<motion.form
			layout
			onSubmit={handleOrganizationLookup}
			className="relative space-y-2"
		>
			<MotionInput
				id={organizationIdInputId}
				placeholder="输入组织 ID…"
				value={organizationId}
				onChange={(e) => setOrganizationId(e.target.value)}
				className="w-full max-w-full"
			/>
			{organizationName && (
				<p className="text-sm text-gray-1">正在登录：{organizationName}</p>
			)}
			<div>
				<Button type="submit" variant="dark" className="w-full max-w-full">
					使用 SSO 继续
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
	const emailInputId = useId();

	return (
		<motion.div>
			<motion.div layout className="flex flex-col space-y-3">
				<MotionInput
					id={emailInputId}
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
					spinner={loading}
					icon={
						loading ? undefined : (
							<FontAwesomeIcon className="mr-1 size-4" icon={faEnvelope} />
						)
					}
				>
					{loading ? "正在发送验证码…" : "使用邮箱登录"}
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
				还没有账号？{" "}
				<Link
					href="/signup"
					className="text-xs font-semibold text-blue-9 hover:text-blue-8"
				>
					在此注册
				</Link>
			</motion.p>

			{(publicEnv.googleAuthAvailable || publicEnv.workosAuthAvailable) && (
				<>
					<div className="flex gap-4 items-center mt-4 mb-4">
						<span className="flex-1 h-px bg-gray-5" />
						<p className="text-sm text-center text-gray-10">或</p>
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
								使用 Google 登录
							</MotionButton>
						)}

						{oauthError && (
							<div className="flex gap-3 items-center p-3 bg-red-400 rounded-xl border border-red-600">
								<FontAwesomeIcon
									className="text-gray-50 size-8"
									icon={faExclamationCircle}
								/>
								<p className="text-xs leading-5 text-gray-50">
									你之前似乎使用此邮箱通过邮箱方式注册过。请输入邮箱继续登录。
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
								使用 SAML SSO 登录
							</MotionButton>
						)}
					</motion.div>
				</>
			)}
		</motion.div>
	);
};
