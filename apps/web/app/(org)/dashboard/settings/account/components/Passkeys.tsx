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
import { useRouter } from "next/navigation";
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
	const router = useRouter();
	const [passkeys, setPasskeys] = useState(initialPasskeys);
	// A passkey added elsewhere (the dashboard prompt) arrives through
	// router.refresh() as a new prop, so take the server's list when it changes.
	const [syncedPasskeys, setSyncedPasskeys] = useState(initialPasskeys);
	if (syncedPasskeys !== initialPasskeys) {
		setSyncedPasskeys(initialPasskeys);
		setPasskeys(initialPasskeys);
	}
	const [supported, setSupported] = useState<boolean | null>(null);
	const [verifyOpen, setVerifyOpen] = useState(false);
	const [verifyPurpose, setVerifyPurpose] = useState<"add" | "remove">("add");
	const [pendingRemove, setPendingRemove] = useState<PasskeyListItem | null>(
		null,
	);
	const [grant, setGrant] = useState<string | null>(null);
	const [registering, setRegistering] = useState(false);
	const [readyOpen, setReadyOpen] = useState(false);
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
					setVerifyPurpose("add");
					setVerifyOpen(true);
				} else if (options.status === "rate_limited") {
					toast.error("Too many attempts. Try again in a minute.");
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
				setGrant(null);
				toast.success("Passkey added");
				router.refresh();
				return;
			}
			toast.error(
				result.status === "duplicate"
					? "That passkey is already on your account."
					: result.status === "limit"
						? `You can add up to ${MAX_PASSKEYS} passkeys.`
						: result.status === "rate_limited"
							? "Too many attempts. Try again in a minute."
							: "Your passkey couldn't be verified. Try again.",
			);
		} catch {
			toast.error("Your passkey couldn't be added. Try again.");
		} finally {
			setRegistering(false);
		}
	};

	const removeMutation = useMutation({
		mutationFn: async (input: { passkey: PasskeyListItem; grant: string }) => {
			const result = await removePasskey(input.passkey.id, input.grant);
			return result.status;
		},
		onSuccess: (status, input) => {
			if (status === "verify") {
				setGrant(null);
				setPendingRemove(input.passkey);
				setRemoveTarget(null);
				setVerifyPurpose("remove");
				setVerifyOpen(true);
				return;
			}
			setPasskeys((current) =>
				current.filter((passkey) => passkey.id !== input.passkey.id),
			);
			setRemoveTarget(null);
			setPendingRemove(null);
			if (status === "removed") toast.success("Passkey removed");
			router.refresh();
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
		setVerifyPurpose("add");
		setVerifyOpen(true);
	};

	const confirmRemove = (passkey: PasskeyListItem) => {
		if (grant) {
			removeMutation.mutate({ passkey, grant });
			return;
		}
		setPendingRemove(passkey);
		setRemoveTarget(null);
		setVerifyPurpose("remove");
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
									{passkey.confirmsIdentity ? "" : " · sign-in only"}
								</p>
							</div>
						</div>
						<Button
							type="button"
							size="xs"
							variant="secondary"
							className="px-3 h-8 text-red-500 hover:text-red-600"
							icon={<Trash2 className="size-3.5" />}
							aria-label={`Remove passkey ${passkey.name}`}
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
				canUsePasskey={
					passkeys.some((passkey) => passkey.confirmsIdentity) &&
					supported === true
				}
				description={
					verifyPurpose === "remove"
						? "Removing a passkey changes how you can sign in, so we need to check it's you first."
						: "Adding a passkey lets it sign in to your account, so we need to check it's you first."
				}
				onVerified={(stepUpGrant) => {
					setGrant(stepUpGrant);
					setVerifyOpen(false);
					if (verifyPurpose === "remove") {
						if (pendingRemove) {
							removeMutation.mutate({
								passkey: pendingRemove,
								grant: stepUpGrant,
							});
						}
						return;
					}
					setReadyOpen(true);
				}}
			/>

			<Dialog open={readyOpen} onOpenChange={setReadyOpen}>
				<DialogContent>
					<DialogHeader
						icon={<Fingerprint className="size-4" />}
						description="Your browser will ask you to use Face ID, Touch ID, Windows Hello or your password manager."
					>
						<DialogTitle>Create your passkey</DialogTitle>
					</DialogHeader>
					<DialogFooter>
						<Button
							type="button"
							size="sm"
							variant="gray"
							onClick={() => setReadyOpen(false)}
						>
							Cancel
						</Button>
						<Button
							type="button"
							size="sm"
							variant="dark"
							icon={<Fingerprint className="size-3.5" />}
							onClick={() => {
								setReadyOpen(false);
								if (grant) register(grant);
							}}
						>
							Create passkey
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

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
							onClick={() => removeTarget && confirmRemove(removeTarget)}
						>
							{removeMutation.isPending ? "Removing..." : "Remove passkey"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</SettingsSection>
	);
};
