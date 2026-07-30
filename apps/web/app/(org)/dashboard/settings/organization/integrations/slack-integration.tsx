"use client";

import { Button } from "@cap/ui";
import type { Organisation } from "@cap/web-domain";
import { MessageSquareIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useTransition } from "react";
import { toast } from "sonner";
import { disconnectOrganizationSlack } from "@/actions/organization/slack";

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
		<div className="rounded-xl border border-gray-3 overflow-hidden">
			<div className="flex items-center gap-3 px-3.5 py-3">
				<MessageSquareIcon className="size-4 shrink-0 text-gray-10" />
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
