"use client";

import { Button, LogoBadge } from "@cap/ui";
import { faArrowLeft } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useMutation } from "@tanstack/react-query";
import { motion } from "framer-motion";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { getSafeNextPath } from "../safe-next";

export function VerifyOTPForm({
	email,
	next,
	lastSent,
}: {
	email: string;
	next?: string;
	lastSent?: string;
}) {
	const [code, setCode] = useState(["", "", "", "", "", ""]);
	const [lastResendTime, setLastResendTime] = useState<number | null>(
		lastSent ? parseInt(lastSent, 10) : null,
	);
	const inputRefs = useRef<(HTMLInputElement | null)[]>([]);
	const router = useRouter();

	useEffect(() => {
		inputRefs.current[0]?.focus();
	}, []);

	const handleChange = (index: number, value: string) => {
		if (value.length > 1) {
			const pastedCode = value.slice(0, 6).split("");
			const newCode = [...code];
			pastedCode.forEach((digit, i) => {
				if (index + i < 6) {
					newCode[index + i] = digit;
				}
			});
			setCode(newCode);

			const nextEmptyIndex = newCode.indexOf("");
			if (nextEmptyIndex !== -1) {
				inputRefs.current[nextEmptyIndex]?.focus();
			} else {
				inputRefs.current[5]?.focus();
			}

			if (newCode.every((d) => d)) handleVerify.mutate(newCode.join(""));
		} else {
			const newCode = [...code];
			newCode[index] = value;
			setCode(newCode);

			if (value && index < 5) {
				inputRefs.current[index + 1]?.focus();
			}
		}
	};

	const handleKeyDown = (
		index: number,
		e: React.KeyboardEvent<HTMLInputElement>,
	) => {
		if (e.key === "Backspace" && !code[index] && index > 0) {
			inputRefs.current[index - 1]?.focus();
		}
	};

	const normalizedEmail = email.toLowerCase();
	const getNextPath = () =>
		next ? getSafeNextPath(next, window.location.origin) : "/dashboard";

	const handleVerify = useMutation({
		mutationFn: async (pastedCode?: string) => {
			const otpCode = pastedCode ?? code.join("");
			if (otpCode.length !== 6) throw "请输入完整的 6 位验证码";
			const nextPath = getNextPath();

			await fetch(
				`/api/auth/callback/email?email=${encodeURIComponent(normalizedEmail)}&token=${encodeURIComponent(otpCode)}&callbackUrl=${encodeURIComponent(nextPath)}`,
			);

			const sessionRes = await fetch("/api/auth/session");
			const session = await sessionRes.json();
			if (!session?.user) {
				setCode(["", "", "", "", "", ""]);
				inputRefs.current[0]?.focus();
				throw "验证码无效，请重试。";
			}
		},
		onSuccess: async () => {
			const nextPath = getNextPath();
			router.refresh();
			router.replace(nextPath);
		},
		onError: (e) => {
			if (typeof e === "string") {
				toast.error(e);
			} else {
				toast.error("发生错误，请重试。");
			}
		},
	});

	const handleResend = useMutation({
		mutationFn: async () => {
			// Check client-side rate limiting
			if (lastResendTime) {
				const timeSinceLastRequest = Date.now() - lastResendTime;
				const waitTime = 30000; // 30 seconds
				if (timeSinceLastRequest < waitTime) {
					const remainingSeconds = Math.ceil(
						(waitTime - timeSinceLastRequest) / 1000,
					);

					throw `请等待 ${remainingSeconds} 秒后再请求新验证码`;
				}
			}

			const result = await signIn("email", {
				email: normalizedEmail,
				redirect: false,
			});

			if (result?.error) {
				// NextAuth returns generic "EmailSignin" error for all email errors
				throw "请等待 30 秒后再请求新验证码";
			}
		},
		onSuccess: () => {
			toast.success("新验证码已发送到你的邮箱！");
			setCode(["", "", "", "", "", ""]);
			inputRefs.current[0]?.focus();
			setLastResendTime(Date.now());
		},
		onError: (e) => {
			if (typeof e === "string") {
				toast.error(e);
			} else {
				toast.error("发生错误，请重试。");
			}
		},
	});

	const isVerifying = handleVerify.isPending || handleVerify.isSuccess;

	return (
		<motion.div
			initial={{ opacity: 0, y: 20 }}
			animate={{ opacity: 1, y: 0 }}
			className="relative w-[calc(100%-5%)] p-[28px] max-w-[432px] bg-gray-3 border border-gray-5 rounded-2xl"
		>
			<Link
				href="/login"
				className="absolute top-5 left-5 z-20 flex gap-2 items-center py-1.5 px-3 text-gray-12 bg-transparent border border-gray-4 rounded-full hover:bg-gray-1 transition-colors duration-300"
			>
				<FontAwesomeIcon className="w-2" icon={faArrowLeft} />
				<p className="text-xs">返回</p>
			</Link>

			<Link className="flex mx-auto size-fit" href="/">
				<LogoBadge className="size-12" />
			</Link>

			<div className="flex flex-col justify-center items-center my-7 text-center">
				<h1 className="text-xl font-semibold text-gray-12">输入验证码</h1>
				<p className="text-sm text-gray-10">
					我们已向 {normalizedEmail} 发送 6 位验证码
				</p>
			</div>

			<div className="flex flex-1 gap-2 justify-between mb-5">
				{code.map((digit, index) => (
					<input
						key={index.toString()}
						ref={(el) => {
							inputRefs.current[index] = el;
						}}
						type="text"
						inputMode="numeric"
						pattern="[0-9]*"
						maxLength={1}
						value={digit}
						onChange={(e) =>
							handleChange(index, e.target.value.replace(/\D/g, ""))
						}
						onKeyDown={(e) => handleKeyDown(index, e)}
						onPaste={(e) => {
							e.preventDefault();
							const pastedData = e.clipboardData
								.getData("text")
								.replace(/\D/g, "");
							handleChange(0, pastedData);
						}}
						className="flex-1 h-[52px] text-xl font-semibold text-center rounded-lg border transition-all bg-gray-1 border-gray-5 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
						disabled={handleVerify.isPending || handleVerify.isSuccess}
					/>
				))}
			</div>

			<Button
				variant="primary"
				className="w-full"
				spinner={isVerifying}
				onClick={() => handleVerify.mutate(code.join(""))}
				disabled={code.some((digit) => !digit) || isVerifying}
			>
				{isVerifying ? "正在验证…" : "验证"}
			</Button>

			<div className="mt-4 text-center">
				<button
					type="button"
					onClick={() => handleResend.mutate()}
					disabled={handleResend.isPending}
					className="text-sm underline transition-colors text-gray-10 hover:text-gray-12"
				>
					{handleResend.isPending ? "正在发送…" : "没有收到验证码？重新发送"}
				</button>
			</div>

			<p className="mt-6 text-xs text-center text-gray-9">
				输入邮箱即表示你已阅读并同意 Cap 的{" "}
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
			</p>
		</motion.div>
	);
}
