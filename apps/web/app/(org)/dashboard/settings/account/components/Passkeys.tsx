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
	startRegistration,
} from "@simplewebauthn/browser";
import { useMutation } from "@tanstack/react-query";
import { Fingerprint, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
	completePasskeyRegistration,
	getPasskeyRegistrationOptions,
	type PasskeyListItem,
	removePasskey,
} from "@/actions/auth/passkeys";
import { isPasskeyCancellation } from "@/lib/passkey-errors";
import {
	SettingsCard,
	SettingsRow,
	SettingsSection,
} from "../../organization/_components/settings-ui";
import { VerifyIdentityDialog } from "./VerifyIdentityDialog";

const MAX_PASSKEYS = 10;

const formatDate = (iso: string) =>
	new Date(iso).toLocaleDateString("en-US", {
		year: "numeric",
		month: "short",
		day: "numeric",
	});

export const Passkeys = ({
	email,
	initialPasskeys,
	loadFailed = false,
}: {
	email: string;
	initialPasskeys: PasskeyListItem[];
	loadFailed?: boolean;
}) => {
	const [passkeys, setPasskeys] = useState(initialPasskeys);
	const [supported, setSupported] = useState<boolean | null>(null);
	const [verifyOpen, setVerifyOpen] = useState(false);
	const [grant, setGrant] = useState<string | null>(null);
	const [registering, setRegistering] = useState(false);
	const [removeTarget, setRemoveTarget] = useState<PasskeyListItem | null>(
		null,
	);

	useEffect(() => {
		setSupported(browserSupportsWebAuthn());
	}, []);

	const register = async (stepUpGrant: string) => {
		setRegistering(true);
		try {
			const options = await getPasskeyRegistrationOptions(stepUpGrant);
			if (options.status !== "ok") {
				if (options.status === "verify") {
					setGrant(null);
					setVerifyOpen(true);
				} else {
					toast.error(`You can add up to ${MAX_PASSKEYS} passkeys.`);
				}
				return;
			}
			let response: Awaited<ReturnType<typeof startRegistration>>;
			try {
				response = await startRegistration({ optionsJSON: options.options });
			} catch (error) {
				if (
					error &&
					typeof error === "object" &&
					(error as { code?: unknown }).code ===
						"ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED"
				) {
					toast.error("That passkey is already on your account.");
				} else if (!isPasskeyCancellation(error)) {
					toast.error("Your passkey couldn't be created. Try again.");
				}
				return;
			}
			const result = await completePasskeyRegistration(
				JSON.stringify(response),
			);
			if (result.status === "registered") {
				setPasskeys((current) => [...current, result.passkey]);
				toast.success("Passkey added");
				return;
			}
			toast.error(
				result.status === "duplicate"
					? "That passkey is already on your account."
					: result.status === "limit"
						? `You can add up to ${MAX_PASSKEYS} passkeys.`
						: "Your passkey couldn't be verified. Try again.",
			);
		} catch {
			toast.error("Your passkey couldn't be added. Try again.");
		} finally {
			setRegistering(false);
		}
	};

	const removeMutation = useMutation({
		mutationFn: (passkeyId: string) => removePasskey(passkeyId),
		onSuccess: (_, passkeyId) => {
			setPasskeys((current) =>
				current.filter((passkey) => passkey.id !== passkeyId),
			);
			setRemoveTarget(null);
			toast.success("Passkey removed");
		},
		onError: () => {
			toast.error("Failed to remove passkey");
		},
	});

	const addPasskey = () => {
		if (grant) {
			register(grant);
			return;
		}
		setVerifyOpen(true);
	};

	return (
		<SettingsSection title="Passkeys">
			<SettingsCard>
				<SettingsRow
					title="Sign in with a passkey"
					description={
						supported === false
							? "This browser doesn't support passkeys. Open Cap in a recent version of Safari, Chrome, Edge or Firefox to add one."
							: "Use Face ID, Touch ID, Windows Hello or your password manager to sign in, instead of waiting for an email code."
					}
					control={
						<Button
							type="button"
							size="sm"
							variant="dark"
							className="px-4 h-9"
							icon={<Fingerprint className="size-3.5" />}
							disabled={
								!supported || registering || passkeys.length >= MAX_PASSKEYS
							}
							spinner={registering}
							onClick={addPasskey}
						>
							Add passkey
						</Button>
					}
				/>
				{loadFailed && (
					<div className="px-4 py-3.5 sm:px-5">
						<div className="px-3 py-2.5 text-sm rounded-lg border border-red-4 bg-red-2 text-red-11">
							Your passkeys could not be loaded. Refresh the page to try again.
						</div>
					</div>
				)}
				{passkeys.map((passkey) => (
					<div
						className="flex flex-col gap-2 px-4 py-3 sm:px-5 md:flex-row md:items-center md:justify-between"
						key={passkey.id}
					>
						<div className="flex gap-3 items-center min-w-0">
							<div className="flex justify-center items-center rounded-lg size-8 shrink-0 bg-gray-3">
								<Fingerprint className="size-3.5 text-gray-10" />
							</div>
							<div className="min-w-0">
								<p className="text-sm font-medium truncate text-gray-12">
									{passkey.name}
								</p>
								<p className="text-xs text-gray-10">
									Added {formatDate(passkey.createdAt)} ·{" "}
									{passkey.lastUsedAt
										? `last used ${formatDate(passkey.lastUsedAt)}`
										: "never used"}
								</p>
							</div>
						</div>
						<Button
							type="button"
							size="xs"
							variant="secondary"
							className="px-3 h-8 text-red-500 hover:text-red-600"
							icon={<Trash2 className="size-3.5" />}
							onClick={() => setRemoveTarget(passkey)}
						>
							Remove
						</Button>
					</div>
				))}
			</SettingsCard>

			<VerifyIdentityDialog
				open={verifyOpen}
				onOpenChange={setVerifyOpen}
				email={email}
				canUsePasskey={passkeys.length > 0 && supported === true}
				description="Adding a passkey lets it sign in to your account, so we need to check it's you first."
				onVerified={(stepUpGrant) => {
					setGrant(stepUpGrant);
					setVerifyOpen(false);
					register(stepUpGrant);
				}}
			/>

			<Dialog
				open={removeTarget !== null}
				onOpenChange={(open) => {
					if (!open) setRemoveTarget(null);
				}}
			>
				<DialogContent>
					<DialogHeader
						icon={<Trash2 className="size-4" />}
						description="It will stop working for Cap sign-in. You can still sign in with your email, and you can also delete it from your device or password manager."
					>
						<DialogTitle>Remove "{removeTarget?.name}"?</DialogTitle>
					</DialogHeader>
					<DialogFooter>
						<Button
							type="button"
							size="sm"
							variant="gray"
							onClick={() => setRemoveTarget(null)}
						>
							Cancel
						</Button>
						<Button
							type="button"
							size="sm"
							variant="destructive"
							disabled={removeMutation.isPending}
							spinner={removeMutation.isPending}
							onClick={() =>
								removeTarget && removeMutation.mutate(removeTarget.id)
							}
						>
							{removeMutation.isPending ? "Removing..." : "Remove passkey"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</SettingsSection>
	);
};
