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
		lastSent ? parseInt(lastSent) : null,
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

			const nextEmptyIndex = newCode.findIndex((digit) => digit === "");
			if (nextEmptyIndex !== -1) {
				inputRefs.current[nextEmptyIndex]?.focus();
			} else {
				inputRefs.current[5]?.focus();
			}

			if (index + value.length >= 5) handleVerify.mutate();
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

	const handleVerify = useMutation({
		mutationFn: async () => {
			const otpCode = code.join("");
			if (otpCode.length !== 6) throw "Please enter a complete 6-digit code";

			// shoutout https://github.com/buoyad/Tally/pull/14
			const res = await fetch(
				`/api/auth/callback/email?email=${encodeURIComponent(email)}&token=${encodeURIComponent(otpCode)}&callbackUrl=${encodeURIComponent("/login-success")}`,
			);

			if (!res.url.includes("/login-success")) {
				setCode(["", "", "", "", "", ""]);
				inputRefs.current[0]?.focus();
				throw "Invalid code. Please try again.";
			}
		},
		onSuccess: () => {
			router.replace(next || "/dashboard");
		},
		onError: (e) => {
			if (typeof e === "string") {
				toast.error(e);
			} else {
				toast.error("An error occurred. Please try again.");
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

					throw `Please wait ${remainingSeconds} seconds before requesting a new code`;
				}
			}

			const result = await signIn("email", {
				email,
				redirect: false,
			});

			if (result?.error) {
				// NextAuth returns generic "EmailSignin" error for all email errors
				throw "Please wait 30 seconds before requesting a new code";
			}
		},
		onSuccess: () => {
			toast.success("A new code has been sent to your email!");
			setCode(["", "", "", "", "", ""]);
			inputRefs.current[0]?.focus();
			setLastResendTime(Date.now());
		},
		onError: (e) => {
			if (typeof e === "string") {
				toast.error(e);
			} else {
				toast.error("An error occurred. Please try again.");
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
				<p className="text-xs">Back</p>
			</Link>

			<Link className="flex mx-auto size-fit" href="/">
				<LogoBadge className="w-[72px] h-[72px]" />
			</Link>

			<div className="flex flex-col justify-center items-center my-7 text-center">
				<h1 className="text-2xl font-semibold text-gray-12">
					Enter verification code
				</h1>
				<p className="text-[16px] text-gray-10 mt-2">
					We sent a 6-digit code to {email}
				</p>
			</div>

			<div className="flex justify-center gap-2 mb-6">
				{code.map((digit, index) => (
					<input
						key={index}
						ref={(el) => (inputRefs.current[index] = el)}
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
						className="w-12 h-14 text-center text-xl font-semibold bg-gray-1 border border-gray-5 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
						disabled={handleVerify.isPending || handleVerify.isSuccess}
					/>
				))}
			</div>

			<Button
				variant="primary"
				className="w-full"
				onClick={() => handleVerify.mutate()}
				disabled={code.some((digit) => !digit) || isVerifying}
			>
				{isVerifying ? "Verifying..." : "Verify Code"}
			</Button>

			<div className="mt-4 text-center">
				<button
					type="button"
					onClick={() => handleResend.mutate()}
					disabled={handleResend.isPending}
					className="text-sm text-gray-10 hover:text-gray-12 underline transition-colors"
				>
					{handleResend.isPending
						? "Sending..."
						: "Didn't receive the code? Resend"}
				</button>
			</div>

			<p className="mt-6 text-xs text-center text-gray-9">
				By verifying your email, you acknowledge that you have both read and
				agree to Cap's{" "}
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
			</p>
		</motion.div>
	);
}
