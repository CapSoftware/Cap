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
import { Mail } from "lucide-react";
import { signOut } from "next-auth/react";
import { useId, useState } from "react";
import { toast } from "sonner";
import {
	finishEmailChange,
	type StartEmailChangeResult,
	startEmailChange,
} from "@/actions/auth/email-change";
import { resetUser } from "@/app/utils/analytics";
import { VerifyIdentityDialog } from "./VerifyIdentityDialog";

type Step = "closed" | "verify" | "email" | "code";

const startErrors: Record<
	Exclude<StartEmailChangeResult["status"], "sent" | "cooldown">,
	string
> = {
	verify: "Please confirm it's you again.",
	invalid: "Enter a valid email address.",
	same: "That's already your email address.",
	not_allowed: "That email address can't be used with Cap.",
	managed: "Your organization manages this email address.",
	rate_limited: "Too many attempts. Try again in a few minutes.",
};

export function ChangeEmail({
	email,
	canUsePasskey,
}: {
	email: string;
	canUsePasskey: boolean;
}) {
	const [step, setStep] = useState<Step>("closed");
	const [grant, setGrant] = useState<string | null>(null);
	const [newEmail, setNewEmail] = useState("");
	const [sentTo, setSentTo] = useState("");
	const [code, setCode] = useState("");
	const [pending, setPending] = useState(false);
	const emailId = useId();
	const codeId = useId();

	const close = () => {
		if (pending) return;
		setStep("closed");
		setNewEmail("");
		setCode("");
	};

	const sendCode = async () => {
		if (!grant) {
			setStep("verify");
			return;
		}
		setPending(true);
		try {
			const result = await startEmailChange(grant, newEmail);
			if (result.status === "sent") {
				setSentTo(result.email);
				setCode("");
				setStep("code");
				return;
			}
			if (result.status === "cooldown") {
				toast.error(
					`Wait ${result.retryAfterSeconds} seconds before requesting another code.`,
				);
				return;
			}
			if (result.status === "verify") {
				setGrant(null);
				setStep("verify");
			}
			toast.error(startErrors[result.status]);
		} catch {
			toast.error("We couldn't send a code. Try again.");
		} finally {
			setPending(false);
		}
	};

	const confirm = async () => {
		setPending(true);
		let changed = false;
		try {
			const result = await finishEmailChange(code);
			if (result.status === "changed") {
				changed = true;
				toast.success("Email updated. Sign in with your new address.");
				resetUser();
				const callbackUrl = `/login?email=${encodeURIComponent(result.email)}`;
				await signOut({ callbackUrl }).catch(() => {
					window.location.assign(callbackUrl);
				});
				return;
			}
			setCode("");
			if (result.status === "invalid") {
				setStep("email");
				toast.error(
					"That code didn't work, so it can't be used again. Send a new code and try once more.",
				);
				return;
			}
			toast.error(
				result.status === "taken"
					? "That email address already has a Cap account."
					: result.status === "not_allowed"
						? "That email address can't be used with Cap."
						: result.status === "managed"
							? "Your organization manages this email address."
							: result.status === "rate_limited"
								? "Too many attempts. Try again in a few minutes."
								: result.status === "failed"
									? "We couldn't update your billing details. Try again."
									: "That code is wrong or has expired. Check it, or request a new one.",
			);
		} catch {
			toast.error("We couldn't change your email. Try again.");
		} finally {
			if (!changed) setPending(false);
		}
	};

	return (
		<>
			<Button
				type="button"
				size="sm"
				variant="gray"
				className="px-4 h-9"
				onClick={() => setStep(grant ? "email" : "verify")}
			>
				Change
			</Button>

			<VerifyIdentityDialog
				open={step === "verify"}
				onOpenChange={(open) => {
					if (!open) close();
				}}
				email={email}
				canUsePasskey={canUsePasskey}
				description="Changing your email changes how you sign in, so we need to check it's you first."
				onVerified={(stepUpGrant) => {
					setGrant(stepUpGrant);
					setStep("email");
				}}
			/>

			<Dialog
				open={step === "email" || step === "code"}
				onOpenChange={(open) => {
					if (!open) close();
				}}
			>
				<DialogContent>
					<DialogHeader
						icon={<Mail className="size-4" />}
						description={
							step === "email"
								? "We'll send a code to the new address to make sure it's yours. After the change you're signed out on the web and sign in again with the new address. To also sign out the desktop app and CLI, use Sign out of all devices."
								: `Enter the code we sent to ${sentTo}.`
						}
					>
						<DialogTitle>Change your email</DialogTitle>
					</DialogHeader>
					{step === "email" ? (
						<form
							onSubmit={(event) => {
								event.preventDefault();
								event.stopPropagation();
								if (newEmail.trim()) sendCode();
							}}
						>
							<div className="p-5 space-y-1.5">
								<label className="text-sm text-gray-11" htmlFor={emailId}>
									New email address
								</label>
								<Input
									id={emailId}
									type="email"
									autoFocus
									autoComplete="email"
									maxLength={255}
									placeholder="you@example.com"
									value={newEmail}
									onChange={(event) => setNewEmail(event.target.value)}
								/>
							</div>
							<DialogFooter>
								<Button
									type="button"
									size="sm"
									variant="gray"
									disabled={pending}
									onClick={close}
								>
									Cancel
								</Button>
								<Button
									type="submit"
									size="sm"
									variant="dark"
									disabled={pending || !newEmail.trim()}
									spinner={pending}
								>
									Send code
								</Button>
							</DialogFooter>
						</form>
					) : (
						<form
							onSubmit={(event) => {
								event.preventDefault();
								event.stopPropagation();
								if (code.length === 6) confirm();
							}}
						>
							<div className="p-5 space-y-1.5">
								<label className="text-sm text-gray-11" htmlFor={codeId}>
									Code
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
									onClick={() => setStep("email")}
								>
									Back
								</Button>
								<Button
									type="submit"
									size="sm"
									variant="dark"
									disabled={pending || code.length !== 6}
									spinner={pending}
								>
									Change email
								</Button>
							</DialogFooter>
						</form>
					)}
				</DialogContent>
			</Dialog>
		</>
	);
}
