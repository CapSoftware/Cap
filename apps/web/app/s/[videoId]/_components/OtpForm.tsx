import { Button } from "@cap/ui";
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import { useEffect, useRef } from "react";
import { toast } from "sonner";

const OtpForm = ({
	email,
	step,
	onClose,
	code,
	setCode,
	lastResendTime,
	setLastResendTime,
}: {
	email: string;
	step: number;
	onClose: () => void;
	code: string[];
	setCode: (code: string[]) => void;
	lastResendTime: number | null;
	setLastResendTime: (time: number | null) => void;
}) => {
	const inputRefs = useRef<(HTMLInputElement | null)[]>([]);
	const router = useRouter();

	useEffect(() => {
		if (step === 2) {
			inputRefs.current[0]?.focus();
		}
	}, [step]);

	const handleOTPChange = (index: number, value: string) => {
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

	const handleOTPKeyDown = (
		index: number,
		e: React.KeyboardEvent<HTMLInputElement>,
	) => {
		if (e.key === "Backspace" && !code[index] && index > 0) {
			inputRefs.current[index - 1]?.focus();
		}
	};

	const normalizedEmail = email.toLowerCase();

	const handleVerify = useMutation({
		mutationFn: async (pastedCode?: string) => {
			const otpCode = pastedCode ?? code.join("");
			if (otpCode.length !== 6) throw "Please enter a complete 6-digit code";

			await fetch(
				`/api/auth/callback/email?email=${encodeURIComponent(normalizedEmail)}&token=${encodeURIComponent(otpCode)}&callbackUrl=${encodeURIComponent("/dashboard")}`,
			);

			const sessionRes = await fetch("/api/auth/session");
			const session = await sessionRes.json();
			if (!session?.user) {
				setCode(["", "", "", "", "", ""]);
				inputRefs.current[0]?.focus();
				throw "Invalid code. Please try again.";
			}
		},
		onSuccess: () => {
			router.refresh();
			toast.success("Sign in successful!");
			onClose();
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
				email: normalizedEmail,
				redirect: false,
			});

			if (result?.error) {
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
		<div className="space-y-4">
			<div className="flex flex-1 gap-2 justify-between">
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
							handleOTPChange(index, e.target.value.replace(/\D/g, ""))
						}
						onKeyDown={(e) => handleOTPKeyDown(index, e)}
						onPaste={(e) => {
							e.preventDefault();
							const pastedData = e.clipboardData
								.getData("text")
								.replace(/\D/g, "");
							handleOTPChange(0, pastedData);
						}}
						className="flex-1 h-[52px] text-lg font-semibold text-center rounded-lg border transition-all bg-gray-1 border-gray-5 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
						disabled={isVerifying}
					/>
				))}
			</div>

			<Button
				variant="dark"
				className="w-full"
				spinner={isVerifying}
				onClick={() => {
					handleVerify.mutate(code.join(""));
				}}
				disabled={code.some((digit) => !digit) || isVerifying}
			>
				{isVerifying ? "Verifying..." : "Verify Code"}
			</Button>

			<div className="text-center">
				<button
					type="button"
					onClick={() => {
						handleResend.mutate(undefined);
					}}
					disabled={handleResend.isPending}
					className="text-sm underline transition-colors text-gray-10 hover:text-gray-12"
				>
					{handleResend.isPending
						? "Sending..."
						: "Didn't receive the code? Resend"}
				</button>
			</div>
		</div>
	);
};

export default OtpForm;
