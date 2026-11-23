"use client";

import {
	Button,
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@cap/ui";
import {
	browserSupportsWebAuthn,
	platformAuthenticatorIsAvailable,
	startRegistration,
} from "@simplewebauthn/browser";
import { Fingerprint } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
	completePasskeyRegistration,
	dismissPasskeyPrompt,
	getPasskeyRegistrationOptionsAfterSignIn,
} from "@/actions/auth/passkeys";
import { isPasskeyCancellation } from "@/lib/passkey-errors";

export function PasskeyPrompt() {
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const [pending, setPending] = useState(false);

	useEffect(() => {
		let cancelled = false;
		if (!browserSupportsWebAuthn()) return;
		platformAuthenticatorIsAvailable()
			.then((available) => {
				if (available && !cancelled) setOpen(true);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, []);

	const notNow = () => {
		setOpen(false);
		dismissPasskeyPrompt().catch(() => {});
	};

	const addPasskey = async () => {
		setPending(true);
		try {
			const options = await getPasskeyRegistrationOptionsAfterSignIn();
			if (options.status !== "ok") {
				setOpen(false);
				if (options.status === "verify") {
					toast.message(
						"You can add a passkey any time from Settings, Account.",
					);
				} else if (options.status === "rate_limited") {
					toast.error("Too many attempts. Try again in a minute.");
				}
				return;
			}
			let response: Awaited<ReturnType<typeof startRegistration>>;
			try {
				response = await startRegistration({ optionsJSON: options.options });
			} catch (error) {
				if (!isPasskeyCancellation(error)) {
					toast.error("Your passkey couldn't be created. Try again.");
				}
				return;
			}
			const result = await completePasskeyRegistration(
				JSON.stringify(response),
			);
			if (result.status === "registered") {
				setOpen(false);
				toast.success("Passkey added. Use it next time you sign in.");
				router.refresh();
				return;
			}
			toast.error(
				result.status === "duplicate"
					? "That passkey is already on your account."
					: "Your passkey couldn't be added. Try again from Settings, Account.",
			);
		} catch {
			toast.error("Your passkey couldn't be added. Try again.");
		} finally {
			setPending(false);
		}
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next && !pending) notNow();
			}}
		>
			<DialogContent>
				<DialogHeader
					icon={<Fingerprint className="size-4" />}
					description="Next time, sign in with Face ID, Touch ID, Windows Hello or your password manager instead of waiting for an email code."
				>
					<DialogTitle>Sign in faster with a passkey</DialogTitle>
				</DialogHeader>
				<DialogFooter>
					<Button
						type="button"
						size="sm"
						variant="gray"
						disabled={pending}
						onClick={notNow}
					>
						Not now
					</Button>
					<Button
						type="button"
						size="sm"
						variant="dark"
						icon={<Fingerprint className="size-3.5" />}
						disabled={pending}
						spinner={pending}
						onClick={addPasskey}
					>
						Add passkey
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
