"use client";

import { Button, Card, CardDescription, CardHeader, CardTitle } from "@cap/ui";
import { SCIM_PRICE_PER_MONTH } from "@cap/utils";
import type { Organisation } from "@cap/web-domain";
import { useCurrency } from "hooks/useCurrency";
import { ExternalLink, RefreshCw, Users } from "lucide-react";
import { useState, useTransition } from "react";
import {
	approveDirectorySyncRemovals,
	getOrganizationDirectorySync,
	type OrganizationDirectorySync,
	openOrganizationDirectorySyncPortal,
} from "@/actions/organization/directory-sync";
import { formatAmount } from "@/utils/currency";

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

export function DirectorySyncCard({
	organizationId,
	organizationName,
	initialStatus,
}: {
	organizationId: Organisation.OrganisationId;
	organizationName: string;
	initialStatus: OrganizationDirectorySync;
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

	return (
		<Card>
			<div className="flex flex-wrap gap-4 justify-between items-start">
				<div className="flex gap-3 items-start">
					<div className="flex justify-center items-center rounded-xl bg-gray-3 size-10 shrink-0">
						<Users className="size-5 text-gray-11" aria-hidden="true" />
					</div>
					<CardHeader>
						<CardTitle>Directory sync (SCIM)</CardTitle>
						<CardDescription className="max-w-xl">
							Add and remove members automatically from Okta, Microsoft Entra
							ID, Google Workspace, and other directories.
						</CardDescription>
					</CardHeader>
				</div>
				<span
					className={`rounded-full px-2.5 py-1 text-xs font-medium ${
						connected ? "bg-green-50 text-green-700" : "bg-gray-3 text-gray-11"
					}`}
				>
					{connected
						? "Active"
						: status.entitled
							? "Ready to set up"
							: "Add-on"}
				</span>
			</div>

			<div className="flex flex-col gap-4 mt-5">
				<p className="text-sm leading-6 text-gray-11">
					People assigned in your directory join{" "}
					<span className="font-medium text-gray-12">{organizationName}</span>{" "}
					as members. When someone is removed or deactivated there, they leave{" "}
					{organizationName} and are signed out of Cap. Members who aren't in
					your directory aren't affected.
				</p>

				{!status.entitled ? (
					<p className="text-sm text-gray-11">
						Directory sync is a {formatAmount(SCIM_PRICE_PER_MONTH, currency)}
						/month add-on. Contact{" "}
						<a className="underline" href="mailto:hello@cap.so">
							hello@cap.so
						</a>{" "}
						to add it to {organizationName}.
					</p>
				) : !status.available ? (
					<p className="text-sm text-gray-11">
						Verify your organization's domain above to set up directory sync.
					</p>
				) : (
					<>
						{status.directories.map((directory) => (
							<p key={directory.id} className="text-sm text-gray-11">
								{directory.name}
								{" · "}
								{directoryStates[directory.state] ?? "Setup not complete"}
							</p>
						))}
						{connected && (
							<p className="text-sm text-gray-11">
								{status.syncedMembers === 1
									? "1 member synced"
									: `${status.syncedMembers} members synced`}
								{lastSynced ? ` · Last synced ${lastSynced}` : ""}
							</p>
						)}
						{status.syncFailed && (
							<output className="text-sm text-gray-11">
								The last sync didn't finish. Cap retries automatically.
							</output>
						)}
						{status.heldRemovals > 0 && (
							<div
								className="flex flex-col gap-3 rounded-xl border border-gray-4 bg-gray-2 p-4"
								role="alert"
							>
								<p className="text-sm leading-6 text-gray-12">
									Sync paused before removing {status.heldRemovals} members.
									This usually means the directory's scope changed. Check your
									directory first, then confirm if these people should leave{" "}
									{organizationName}.
								</p>
								<Button
									type="button"
									size="sm"
									variant="dark"
									className="w-fit"
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
						)}
						<div className="flex flex-wrap gap-2">
							<Button
								type="button"
								size="sm"
								variant="dark"
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
							<Button
								type="button"
								size="sm"
								variant="outline"
								disabled={busy}
								spinner={pendingAction === "refresh"}
								onClick={() =>
									runAction("refresh", async () => {
										setStatus(
											await getOrganizationDirectorySync(organizationId),
										);
									})
								}
							>
								{pendingAction !== "refresh" && (
									<RefreshCw className="mr-1 size-3.5" aria-hidden="true" />
								)}
								Refresh status
							</Button>
						</div>
					</>
				)}

				{error && (
					<p
						className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700"
						role="alert"
					>
						{error}
					</p>
				)}
			</div>
		</Card>
	);
}
