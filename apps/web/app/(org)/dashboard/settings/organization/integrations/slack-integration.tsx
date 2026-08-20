"use client";

import { Button } from "@cap/ui";
import type { Organisation } from "@cap/web-domain";
import { useRouter } from "next/navigation";
import { useEffect, useTransition } from "react";
import { toast } from "sonner";
import { disconnectOrganizationSlack } from "@/actions/organization/slack";

const SlackIcon = ({ className }: { className?: string }) => (
	<svg
		viewBox="0 0 127 127"
		className={className}
		aria-hidden="true"
		focusable="false"
	>
		<path
			d="M27.2 80c0 7.3-5.9 13.2-13.2 13.2C6.7 93.2.8 87.3.8 80c0-7.3 5.9-13.2 13.2-13.2h13.2V80zm6.6 0c0-7.3 5.9-13.2 13.2-13.2 7.3 0 13.2 5.9 13.2 13.2v33c0 7.3-5.9 13.2-13.2 13.2-7.3 0-13.2-5.9-13.2-13.2V80z"
			fill="#E01E5A"
		/>
		<path
			d="M47 27c-7.3 0-13.2-5.9-13.2-13.2C33.8 6.5 39.7.6 47 .6c7.3 0 13.2 5.9 13.2 13.2V27H47zm0 6.7c7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2H13.9C6.6 60.1.7 54.2.7 46.9c0-7.3 5.9-13.2 13.2-13.2H47z"
			fill="#36C5F0"
		/>
		<path
			d="M99.9 46.9c0-7.3 5.9-13.2 13.2-13.2 7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2H99.9V46.9zm-6.6 0c0 7.3-5.9 13.2-13.2 13.2-7.3 0-13.2-5.9-13.2-13.2V13.8C66.9 6.5 72.8.6 80.1.6c7.3 0 13.2 5.9 13.2 13.2v33.1z"
			fill="#2EB67D"
		/>
		<path
			d="M80.1 99.8c7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2-7.3 0-13.2-5.9-13.2-13.2V99.8h13.2zm0-6.6c-7.3 0-13.2-5.9-13.2-13.2 0-7.3 5.9-13.2 13.2-13.2h33.1c7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2H80.1z"
			fill="#ECB22E"
		/>
	</svg>
);

type SlackInstallation = {
	id: string;
	teamId: string;
	teamName: string;
};

const resultMessages: Record<
	string,
	{ type: "success" | "error"; message: string }
> = {
	connected: {
		type: "success",
		message: "Slack workspace connected",
	},
	cancelled: {
		type: "error",
		message: "Slack connection was cancelled",
	},
	failed: {
		type: "error",
		message: "Slack connection failed",
	},
	forbidden: {
		type: "error",
		message: "Only organization admins can connect Slack",
	},
	invalid: {
		type: "error",
		message: "Slack connection expired or was invalid",
	},
	"not-configured": {
		type: "error",
		message: "Slack is not configured on this Cap deployment",
	},
};

export function SlackIntegration({
	organizationId,
	configured,
	installations,
	result,
}: {
	organizationId: Organisation.OrganisationId;
	configured: boolean;
	installations: SlackInstallation[];
	result?: string;
}) {
	const router = useRouter();
	const [isPending, startTransition] = useTransition();
	const connected = configured && installations.length > 0;

	useEffect(() => {
		if (!result) return;
		const notification = resultMessages[result];
		if (notification?.type === "success") {
			toast.success(notification.message);
		} else if (notification) {
			toast.error(notification.message);
		}
		router.replace("/dashboard/settings/organization/integrations");
	}, [result, router]);

	const disconnect = (installation: SlackInstallation) => {
		if (
			!window.confirm(
				`Disconnect ${installation.teamName} from Cap link previews?`,
			)
		) {
			return;
		}
		startTransition(async () => {
			try {
				await disconnectOrganizationSlack({
					organizationId,
					installationId: installation.id,
				});
				toast.success(`${installation.teamName} disconnected`);
				router.refresh();
			} catch (error) {
				toast.error(
					error instanceof Error ? error.message : "Failed to disconnect Slack",
				);
			}
		});
	};

	return (
		<div className="rounded-xl border border-gray-3 overflow-hidden bg-gray-1 shadow-xs">
			<div className="flex items-center gap-3 px-3.5 py-3">
				<SlackIcon className="size-4 shrink-0" />
				<div className="flex-1 min-w-0">
					<p className="text-[13px] font-medium text-gray-12">Slack</p>
					<p className="text-[11px] text-gray-9">
						Play public Cap recordings directly inside Slack.
					</p>
				</div>
				<span
					className={
						connected
							? "inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium rounded-md bg-green-500/10 text-green-600"
							: "inline-flex items-center px-2 py-0.5 text-[11px] font-medium rounded-md bg-gray-3 text-gray-9"
					}
				>
					{connected
						? "Connected"
						: configured
							? "Not connected"
							: "Not configured"}
				</span>
			</div>

			<div className="border-t border-gray-3 px-3.5 py-4">
				{installations.length > 0 && (
					<div className="flex flex-col gap-2 mb-3">
						{installations.map((installation) => (
							<div
								key={installation.id}
								className="flex items-center justify-between gap-3 rounded-lg bg-gray-2 px-3 py-2.5"
							>
								<div className="min-w-0">
									<p className="truncate text-[12px] font-medium text-gray-12">
										{installation.teamName}
									</p>
									<p className="truncate text-[10px] text-gray-9">
										{installation.teamId}
									</p>
								</div>
								<Button
									type="button"
									size="xs"
									variant="destructive"
									disabled={isPending}
									onClick={() => disconnect(installation)}
								>
									Disconnect
								</Button>
							</div>
						))}
					</div>
				)}

				<div className="flex items-center justify-between gap-3">
					<p className="text-[12px] text-gray-10">
						{configured
							? "Install Cap in each Slack workspace where links should open as inline players."
							: "Add the Slack app credentials and database encryption key to this deployment before connecting a workspace."}
					</p>
					{configured ? (
						<Button
							href="/api/integrations/slack/install"
							size="xs"
							disabled={isPending}
						>
							{installations.length > 0
								? "Connect another workspace"
								: "Connect Slack"}
						</Button>
					) : (
						<Button size="xs" disabled>
							Connect Slack
						</Button>
					)}
				</div>
			</div>
		</div>
	);
}
