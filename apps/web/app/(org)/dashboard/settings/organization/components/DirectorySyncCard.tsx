"use client";

import { Button } from "@cap/ui";
import { SCIM_PRICE_PER_MONTH } from "@cap/utils";
import type { Organisation } from "@cap/web-domain";
import { useCurrency } from "hooks/useCurrency";
import { ExternalLink, RefreshCw } from "lucide-react";
import { useState, useTransition } from "react";
import {
	approveDirectorySyncRemovals,
	getOrganizationDirectorySync,
	type OrganizationDirectorySync,
	openOrganizationDirectorySyncPortal,
} from "@/actions/organization/directory-sync";
import { formatAmount } from "@/utils/currency";
import { DirectoryDoodle } from "../_components/doodles";
import {
	SettingsNotice,
	SettingsRow,
	StatusChip,
} from "../_components/settings-ui";

type DirectoryAction = "portal" | "approve" | "refresh";

const actionErrors: Record<DirectoryAction, string> = {
	portal:
		"We couldn't open directory sync setup. Please try again or contact support.",
	approve: "We couldn't approve the removals. Please try again.",
	refresh: "We couldn't refresh directory sync status. Please try again.",
};

const directoryStates: Record<string, string> = {
	active: "Connected",
	validating: "Connecting",
	invalid_credentials: "Needs attention",
	inactive: "Not connected",
	deleting: "Disconnecting",
};

export const directorySyncNotAdded: OrganizationDirectorySync = {
	entitled: false,
	available: false,
	directories: [],
	syncedMembers: 0,
	lastSyncedAt: null,
	syncFailed: false,
	heldRemovals: 0,
};

export function DirectorySyncCard({
	organizationId,
	organizationName,
	initialStatus,
	requiresSso = false,
}: {
	organizationId: Organisation.OrganisationId;
	organizationName: string;
	initialStatus: OrganizationDirectorySync;
	requiresSso?: boolean;
}) {
	const { currency } = useCurrency();
	const [status, setStatus] = useState(initialStatus);
	const [pendingAction, setPendingAction] = useState<DirectoryAction | null>(
		null,
	);
	const [error, setError] = useState<string | null>(null);
	const [isPending, startTransition] = useTransition();
	const busy = isPending || pendingAction !== null;
	const connected = status.directories.some(
		(directory) => directory.state === "active",
	);
	const lastSynced = status.lastSyncedAt
		? new Date(status.lastSyncedAt).toLocaleString("en-GB", {
				day: "numeric",
				month: "short",
				hour: "2-digit",
				minute: "2-digit",
			})
		: null;

	const runAction = (
		action: DirectoryAction,
		operation: () => Promise<void>,
	) => {
		if (busy) return;
		setPendingAction(action);
		setError(null);
		startTransition(async () => {
			let navigating = false;
			try {
				await operation();
				navigating = action === "portal";
			} catch {
				setError(actionErrors[action]);
			} finally {
				if (!navigating) setPendingAction(null);
			}
		});
	};

	const canSetUp = status.entitled && status.available;
	const price = formatAmount(SCIM_PRICE_PER_MONTH, currency);

	return (
		<SettingsRow
			anchor="directory-sync"
			icon={<DirectoryDoodle />}
			title="Directory sync (SCIM)"
			meta={
				<StatusChip tone={connected ? "positive" : "neutral"}>
					{connected
						? "Active"
						: status.entitled
							? "Ready to set up"
							: "Add-on"}
				</StatusChip>
			}
			description="Add and remove members automatically from Okta, Microsoft Entra ID, Google Workspace, and other directories."
			control={
				canSetUp ? (
					<Button
						type="button"
						size="xs"
						variant="dark"
						className="px-4"
						disabled={busy}
						spinner={pendingAction === "portal"}
						onClick={() =>
							runAction("portal", async () => {
								const { url } =
									await openOrganizationDirectorySyncPortal(organizationId);
								window.location.assign(url);
							})
						}
					>
						{status.directories.length
							? "Manage directory sync"
							: "Set up directory sync"}
						<ExternalLink className="ml-1 size-3.5" aria-hidden="true" />
					</Button>
				) : status.entitled || requiresSso ? null : (
					<a
						href="mailto:hello@cap.so?subject=Add%20directory%20sync"
						className="inline-flex justify-center items-center px-4 h-8 text-xs font-medium rounded-full border transition-colors border-gray-4 text-gray-12 hover:border-gray-5 hover:bg-gray-3"
					>
						Email us to add it
					</a>
				)
			}
		>
			<div className="flex flex-col gap-3 mt-4 sm:pl-[58px]">
				{status.entitled && (
					<p className="text-[13px] leading-5 text-gray-10">
						People assigned in your directory join{" "}
						<span className="font-medium text-gray-12">{organizationName}</span>{" "}
						as members. When someone is removed or deactivated there, they leave{" "}
						{organizationName} and are signed out of Cap. Members who aren't in
						your directory aren't affected.
					</p>
				)}

				{!status.entitled ? (
					<p className="text-[13px] leading-5 text-gray-11">
						Directory sync is a {price}
						/month add-on
						{requiresSso
							? " that works with SAML SSO. Add SAML SSO first, then contact "
							: ". Contact "}
						<a className="underline" href="mailto:hello@cap.so">
							hello@cap.so
						</a>{" "}
						to add it to {organizationName}.
					</p>
				) : !status.available ? (
					<p className="text-[13px] leading-5 text-gray-11">
						Verify your organization's domain above to set up directory sync.
					</p>
				) : (
					<>
						{status.directories.map((directory) => (
							<p key={directory.id} className="text-[13px] text-gray-11">
								{directory.name}
								{" · "}
								{directoryStates[directory.state] ?? "Setup not complete"}
							</p>
						))}
						{connected && (
							<p className="text-[13px] text-gray-11">
								{status.syncedMembers === 1
									? "1 member synced"
									: `${status.syncedMembers} members synced`}
								{lastSynced ? ` · Last synced ${lastSynced}` : ""}
							</p>
						)}
						{status.syncFailed && (
							<output className="text-[13px] text-gray-11">
								The last sync didn't finish. Cap retries automatically.
							</output>
						)}
						{status.heldRemovals > 0 && (
							<SettingsNotice role="alert">
								<div className="flex flex-col gap-3">
									<p className="text-gray-12">
										Sync paused before removing {status.heldRemovals} members.
										This usually means the directory's scope changed. Check your
										directory first, then confirm if these people should leave{" "}
										{organizationName}.
									</p>
									<Button
										type="button"
										size="xs"
										variant="dark"
										className="px-4 w-fit"
										disabled={busy}
										spinner={pendingAction === "approve"}
										onClick={() =>
											runAction("approve", async () => {
												setStatus(
													await approveDirectorySyncRemovals(
														organizationId,
														status.heldRemovals,
													),
												);
											})
										}
									>
										Remove {status.heldRemovals} members
									</Button>
								</div>
							</SettingsNotice>
						)}
						<Button
							type="button"
							size="xs"
							variant="outline"
							className="px-4 w-fit"
							disabled={busy}
							spinner={pendingAction === "refresh"}
							onClick={() =>
								runAction("refresh", async () => {
									setStatus(await getOrganizationDirectorySync(organizationId));
								})
							}
						>
							{pendingAction !== "refresh" && (
								<RefreshCw className="mr-1 size-3.5" aria-hidden="true" />
							)}
							Refresh status
						</Button>
					</>
				)}

				{error && (
					<SettingsNotice tone="danger" role="alert">
						{error}
					</SettingsNotice>
				)}
			</div>
		</SettingsRow>
	);
}
