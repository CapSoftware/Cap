"use client";

import { Button, Card, CardDescription, CardHeader, CardTitle } from "@cap/ui";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import {
	type DirectorySyncSettings,
	getDirectorySyncSettings,
	openDirectorySyncPortal,
} from "@/actions/organization/directory-sync";

export function DirectorySyncCard({
	initialSettings,
}: {
	initialSettings: DirectorySyncSettings;
}) {
	const [settings, setSettings] = useState(initialSettings);
	const [error, setError] = useState<string | null>(null);
	const [pending, startTransition] = useTransition();
	const inFlight = useRef(false);
	const router = useRouter();
	const labels: Record<string, string> = {
		unconfigured: "Available on request",
		pending: "Waiting for your directory",
		active: "Connected",
		inactive: "Connection needs attention",
		deleted: "Directory disconnected",
	};
	function run(action: "portal" | "refresh") {
		if (inFlight.current) return;
		inFlight.current = true;
		setError(null);
		startTransition(async () => {
			try {
				if (action === "portal") {
					const { url } = await openDirectorySyncPortal(
						settings.organizationId,
					);
					window.location.assign(url);
				} else {
					setSettings(await getDirectorySyncSettings(settings.organizationId));
					router.refresh();
				}
			} catch {
				setError(
					action === "portal"
						? "We couldn't open provisioning setup. Check that SSO and your work email domain are configured, or contact Cap for help."
						: "We couldn't refresh provisioning status. Please try again.",
				);
			} finally {
				inFlight.current = false;
			}
		});
	}
	return (
		<Card>
			<CardHeader>
				<div className="flex items-center justify-between gap-4">
					<CardTitle>User provisioning</CardTitle>
					<span className="text-sm text-gray-11">
						{labels[settings.state] ?? "Connection needs attention"}
					</span>
				</div>
				<CardDescription>
					Automatically add and remove organization access through your identity
					provider using SCIM.
				</CardDescription>
			</CardHeader>
			<div className="flex flex-col gap-4 px-6 pb-6">
				<p className="text-sm text-gray-11">
					New users join as members. Pro seats and roles remain managed in Cap.
					Removing a user revokes their organization access and preserves their
					recordings.
				</p>
				{settings.configured ? (
					<>
						<p className="text-sm text-gray-12">
							{settings.activeUsers} active · {settings.inactiveUsers}{" "}
							deprovisioned
						</p>
						{settings.usersNeedingReview > 0 ? (
							<output className="text-sm text-gray-11">
								{settings.usersNeedingReview} users need an identity review.
								Contact Cap to resolve missing emails, domain verification, or
								account changes.
							</output>
						) : null}
						<p className="text-sm text-gray-11">
							{settings.lastSyncedAt
								? `Last checked ${settings.lastSyncedAt.slice(0, 16).replace("T", " ")} UTC.`
								: "Waiting for the first sync."}{" "}
							Directory changes are checked every minute; your identity provider
							may take longer to send them.
						</p>
						{settings.hasError ? (
							<p role="alert" className="text-sm text-red-600">
								Provisioning needs attention. Changes will be retried
								automatically. Contact Cap if this continues.
							</p>
						) : null}
					</>
				) : null}
				{settings.state === "deleted" ? (
					<p className="text-sm text-gray-11">
						Contact Cap before connecting a replacement directory so existing
						identities can be reconciled safely.
					</p>
				) : null}
				<div className="flex flex-wrap gap-3">
					{settings.entitled ? (
						<Button
							type="button"
							variant="primary"
							disabled={pending || settings.state === "deleted"}
							onClick={() => run("portal")}
						>
							{settings.configured
								? "Manage provisioning"
								: "Set up provisioning"}
						</Button>
					) : (
						<a
							className="text-sm underline"
							href="mailto:hello@cap.so?subject=User%20provisioning"
						>
							Contact us to enable provisioning
						</a>
					)}
					{settings.configured ? (
						<Button
							type="button"
							variant="gray"
							disabled={pending}
							onClick={() => run("refresh")}
						>
							Refresh status
						</Button>
					) : null}
				</div>
				{error ? (
					<p role="alert" className="text-sm text-red-600">
						{error}
					</p>
				) : null}
			</div>
		</Card>
	);
}
