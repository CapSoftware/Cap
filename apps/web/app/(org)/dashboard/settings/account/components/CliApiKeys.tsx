"use client";

import {
	Button,
	Card,
	CardDescription,
	CardTitle,
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	Input,
	Select,
} from "@cap/ui";
import { useMutation } from "@tanstack/react-query";
import { KeyRound, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { toast } from "sonner";
import { ApiKeyDisplay } from "../../../developers/_components/ApiKeyDisplay";
import {
	type CliApiKeySummary,
	createCliApiKey,
	revokeCliApiKey,
} from "../server";

const profileOptions = [
	{
		value: "creator",
		label: "Creator: caps, uploads, library, analytics, notifications",
	},
	{
		value: "admin",
		label: "Admin: creator plus organizations, billing, integrations",
	},
	{
		value: "full",
		label: "Full: admin plus developer apps and credentials",
	},
];

const expiryOptions = [
	{ value: "30", label: "30 days" },
	{ value: "90", label: "90 days" },
	{ value: "365", label: "1 year" },
];

// Locale-pinned so the server-rendered HTML matches what every browser hydrates.
const formatDate = (iso: string) =>
	new Date(iso).toLocaleDateString("en-US", {
		year: "numeric",
		month: "short",
		day: "numeric",
	});

export const CliApiKeys = ({
	initialKeys,
}: {
	initialKeys: CliApiKeySummary[];
}) => {
	const router = useRouter();
	const [keys, setKeys] = useState(initialKeys);
	const [createOpen, setCreateOpen] = useState(false);
	const [name, setName] = useState("");
	const [profile, setProfile] = useState("creator");
	const [expiresInDays, setExpiresInDays] = useState("90");
	const [mintedToken, setMintedToken] = useState<string | null>(null);
	const [revokeTarget, setRevokeTarget] = useState<CliApiKeySummary | null>(
		null,
	);
	const nameId = useId();

	const createMutation = useMutation({
		mutationFn: () =>
			createCliApiKey({
				name,
				profile,
				expiresInDays: Number(expiresInDays),
			}),
		onSuccess: ({ token, key }) => {
			setKeys((current) => [key, ...current]);
			setCreateOpen(false);
			setName("");
			setMintedToken(token);
			router.refresh();
		},
		onError: (error) => {
			toast.error(
				error instanceof Error ? error.message : "Failed to create API key",
			);
		},
	});

	const revokeMutation = useMutation({
		mutationFn: (keyId: string) => revokeCliApiKey(keyId),
		onSuccess: (_, keyId) => {
			setKeys((current) => current.filter((key) => key.id !== keyId));
			setRevokeTarget(null);
			toast.success("API key revoked");
			router.refresh();
		},
		onError: () => {
			toast.error("Failed to revoke API key");
		},
	});

	return (
		<Card className="flex flex-col gap-4 mt-6">
			<div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
				<div className="space-y-1">
					<CardTitle>Cap CLI access</CardTitle>
					<CardDescription>
						API keys authenticate the Cap CLI in environments without a browser,
						such as CI runners and remote sandboxes. Keys created by{" "}
						<code>cap auth login</code> also appear here.
					</CardDescription>
				</div>
				<Button
					type="button"
					size="sm"
					variant="dark"
					icon={<KeyRound className="size-4" />}
					onClick={() => setCreateOpen(true)}
				>
					Create API key
				</Button>
			</div>
			{keys.length > 0 && (
				<div className="flex flex-col divide-y divide-gray-3 rounded-xl border border-gray-4">
					{keys.map((key) => {
						const expired = new Date(key.expiresAt).getTime() <= Date.now();
						return (
							<div
								className="flex flex-col gap-2 px-4 py-3 md:flex-row md:items-center md:justify-between"
								key={key.id}
							>
								<div className="min-w-0">
									<p className="truncate text-sm font-medium text-gray-12">
										{key.name}
									</p>
									<p className="text-xs text-gray-10">
										{key.scopes.length} scopes · created{" "}
										{formatDate(key.createdAt)} ·{" "}
										{key.lastUsedAt
											? `last used ${formatDate(key.lastUsedAt)}`
											: "never used"}{" "}
										·{" "}
										{expired
											? "expired"
											: `expires ${formatDate(key.expiresAt)}`}
									</p>
								</div>
								<Button
									type="button"
									size="xs"
									variant="destructive"
									icon={<Trash2 className="size-3.5" />}
									onClick={() => setRevokeTarget(key)}
								>
									Revoke
								</Button>
							</div>
						);
					})}
				</div>
			)}

			<Dialog open={createOpen} onOpenChange={setCreateOpen}>
				<DialogContent>
					<DialogHeader
						icon={<KeyRound className="size-4" />}
						description="The key gets the same permissions as the matching cap auth login profile."
					>
						<DialogTitle>Create a CLI API key</DialogTitle>
					</DialogHeader>
					<form
						onSubmit={(event) => {
							event.preventDefault();
							createMutation.mutate();
						}}
					>
						<div className="p-5 space-y-4">
							<div className="space-y-1.5">
								<label className="text-sm text-gray-11" htmlFor={nameId}>
									Name
								</label>
								<Input
									id={nameId}
									maxLength={100}
									onChange={(event) => setName(event.target.value)}
									placeholder="e.g. Build sandbox"
									type="text"
									value={name}
								/>
							</div>
							<div className="space-y-1.5">
								<p className="text-sm text-gray-11">Access profile</p>
								<Select
									onValueChange={setProfile}
									options={profileOptions}
									placeholder="Access profile"
									value={profile}
								/>
							</div>
							<div className="space-y-1.5">
								<p className="text-sm text-gray-11">Expires after</p>
								<Select
									onValueChange={setExpiresInDays}
									options={expiryOptions}
									placeholder="Expiry"
									value={expiresInDays}
								/>
							</div>
						</div>
						<DialogFooter>
							<Button
								type="button"
								size="sm"
								variant="gray"
								onClick={() => setCreateOpen(false)}
							>
								Cancel
							</Button>
							<Button
								type="submit"
								size="sm"
								variant="dark"
								disabled={name.trim().length === 0 || createMutation.isPending}
								spinner={createMutation.isPending}
							>
								{createMutation.isPending ? "Creating..." : "Create key"}
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>

			<Dialog
				open={mintedToken !== null}
				onOpenChange={(open) => {
					if (!open) setMintedToken(null);
				}}
			>
				<DialogContent>
					<DialogHeader
						icon={<KeyRound className="size-4" />}
						description="Cap stores only a hash of this key, so it cannot be shown again."
					>
						<DialogTitle>Copy your API key</DialogTitle>
					</DialogHeader>
					<div className="p-5 space-y-4">
						{mintedToken && (
							<ApiKeyDisplay label="API key" sensitive value={mintedToken} />
						)}
						<p className="text-sm text-gray-11">
							Set it as <code>CAP_API_KEY</code> (or{" "}
							<code>CAP_AGENT_TOKEN</code>) in the environment where the Cap CLI
							runs, then verify with <code>cap auth status --json</code>.
						</p>
					</div>
					<DialogFooter>
						<Button
							type="button"
							size="sm"
							variant="dark"
							onClick={() => setMintedToken(null)}
						>
							Done
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<Dialog
				open={revokeTarget !== null}
				onOpenChange={(open) => {
					if (!open) setRevokeTarget(null);
				}}
			>
				<DialogContent>
					<DialogHeader
						icon={<Trash2 className="size-4" />}
						description="Anything authenticating with this key loses access immediately."
					>
						<DialogTitle>Revoke "{revokeTarget?.name}"?</DialogTitle>
					</DialogHeader>
					<DialogFooter>
						<Button
							type="button"
							size="sm"
							variant="gray"
							onClick={() => setRevokeTarget(null)}
						>
							Cancel
						</Button>
						<Button
							type="button"
							size="sm"
							variant="destructive"
							disabled={revokeMutation.isPending}
							spinner={revokeMutation.isPending}
							onClick={() =>
								revokeTarget && revokeMutation.mutate(revokeTarget.id)
							}
						>
							{revokeMutation.isPending ? "Revoking..." : "Revoke key"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</Card>
	);
};
