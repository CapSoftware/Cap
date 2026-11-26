"use client";

import {
	Button,
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	Input,
} from "@cap/ui";
import { startAuthentication } from "@simplewebauthn/browser";
import { ShieldCheck } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import {
	getPasskeyStepUpOptions,
	sendSecurityCode,
	verifyPasskeyForStepUp,
	verifySecurityCode,
} from "@/actions/auth/passkeys";
import { isPasskeyCancellation } from "@/lib/passkey-errors";

type Step = "choose" | "code";

export function VerifyIdentityDialog({
	open,
	onOpenChange,
	email,
	canUsePasskey,
	description,
	onVerified,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	email: string;
	canUsePasskey: boolean;
	description: string;
	onVerified: (grant: string) => void;
}) {
	const [step, setStep] = useState<Step>("choose");
	const [code, setCode] = useState("");
	const [pending, setPending] = useState(false);
	const codeId = useId();

	useEffect(() => {
		if (!open) {
			setStep("choose");
			setCode("");
			setPending(false);
		}
	}, [open]);

	const sendCode = async () => {
		setPending(true);
		try {
			const result = await sendSecurityCode();
			if (result.status === "sent") {
				setStep("code");
				toast.success(`We sent a code to ${email}`);
			} else if (result.status === "cooldown") {
				setStep("code");
				toast.error(
					`Wait ${result.retryAfterSeconds} seconds before requesting another code.`,
				);
			} else {
				toast.error("Too many codes requested. Try again in a few minutes.");
			}
		} catch {
			toast.error("We couldn't send a code. Try again.");
		} finally {
			setPending(false);
		}
	};

	const verifyCode = async () => {
		setPending(true);
		try {
			const result = await verifySecurityCode(code);
			if (result.status === "ok") {
				onVerified(result.grant);
				return;
			}
			setCode("");
			toast.error(
				result.status === "rate_limited"
					? "Too many attempts. Try again in a few minutes."
					: "That code is wrong or has expired. Check it, or request a new one.",
			);
		} catch {
			toast.error("We couldn't check that code. Try again.");
		} finally {
			setPending(false);
		}
	};

	const verifyWithPasskey = async () => {
		setPending(true);
		try {
			const options = await getPasskeyStepUpOptions();
			if (options.status !== "ok") {
				toast.error(
					options.status === "rate_limited"
						? "Too many attempts. Try again in a minute."
						: "No passkey found. Use an email code instead.",
				);
				return;
			}
			let response: Awaited<ReturnType<typeof startAuthentication>>;
			try {
				response = await startAuthentication({ optionsJSON: options.options });
			} catch (error) {
				if (!isPasskeyCancellation(error)) {
					toast.error("Your passkey couldn't be used. Try an email code.");
				}
				return;
			}
			const result = await verifyPasskeyForStepUp(JSON.stringify(response));
			if (result.status === "ok") {
				onVerified(result.grant);
				return;
			}
			toast.error(
				result.status === "rate_limited"
					? "Too many attempts. Try again in a minute."
					: "Your passkey couldn't be verified. Try an email code.",
			);
		} catch {
			toast.error("Your passkey couldn't be verified. Try an email code.");
		} finally {
			setPending(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
			<DialogContent>
				<DialogHeader
					icon={<ShieldCheck className="size-4" />}
					description={description}
				>
					<DialogTitle>Confirm it's you</DialogTitle>
				</DialogHeader>
				{step === "choose" ? (
					<>
						<div className="p-5 text-sm text-gray-11">
							{canUsePasskey
								? "Use one of your passkeys, or we can email a code to "
								: "We'll email a code to "}
							<span className="font-medium text-gray-12">{email}</span>.
						</div>
						<DialogFooter>
							{canUsePasskey && (
								<Button
									type="button"
									size="sm"
									variant="gray"
									disabled={pending}
									onClick={sendCode}
								>
									Email me a code
								</Button>
							)}
							<Button
								type="button"
								size="sm"
								variant="dark"
								disabled={pending}
								spinner={pending}
								onClick={canUsePasskey ? verifyWithPasskey : sendCode}
							>
								{canUsePasskey ? "Use a passkey" : "Send code"}
							</Button>
						</DialogFooter>
					</>
				) : (
					<form
						onSubmit={(event) => {
							event.preventDefault();
							event.stopPropagation();
							if (code.length === 6) verifyCode();
						}}
					>
						<div className="p-5 space-y-1.5">
							<label className="text-sm text-gray-11" htmlFor={codeId}>
								Code sent to {email}
							</label>
							<Input
								id={codeId}
								autoFocus
								inputMode="numeric"
								autoComplete="one-time-code"
								maxLength={6}
								placeholder="123456"
								value={code}
								onChange={(event) =>
									setCode(event.target.value.replace(/\D/g, "").slice(0, 6))
								}
							/>
						</div>
						<DialogFooter>
							<Button
								type="button"
								size="sm"
								variant="gray"
								disabled={pending}
								onClick={sendCode}
							>
								Send a new code
							</Button>
							<Button
								type="submit"
								size="sm"
								variant="dark"
								disabled={pending || code.length !== 6}
								spinner={pending}
							>
								Confirm
							</Button>
						</DialogFooter>
					</form>
				)}
			</DialogContent>
		</Dialog>
	);
}
