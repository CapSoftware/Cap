"use client";

import { MousePointer2 } from "lucide-react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { playerColorFromOrganizationMetadata } from "@/lib/player-brand";
import {
	callToActionDestinationLabel,
	parseWorkspaceCallToAction,
	readableTextColor,
} from "@/lib/share-call-to-action";
import { useDashboardContext } from "../../../Contexts";
import {
	ProChip,
	SettingsCard,
	SettingsRow,
	SettingsSection,
} from "../_components/settings-ui";

const CallToActionDialog = dynamic(
	() =>
		import(
			"@/app/s/[videoId]/_components/call-to-action/CallToActionDialog"
		).then((m) => m.CallToActionDialog),
	{ ssr: false },
);

const pillButtonClass =
	"flex gap-1.5 items-center px-3 h-8 text-[13px] font-medium rounded-full border shadow-xs transition-colors border-gray-4 bg-gray-1 text-gray-12 hover:bg-gray-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-9";

export function DefaultCallToAction() {
	const router = useRouter();
	const {
		activeOrganization,
		organizationSettings,
		user,
		setUpgradeModalOpen,
	} = useDashboardContext();
	const [dialogMounted, setDialogMounted] = useState(false);
	const [dialogOpen, setDialogOpen] = useState(false);

	const organizationId = activeOrganization?.organization.id;
	if (!organizationId) return null;

	const workspace = parseWorkspaceCallToAction(organizationSettings);
	const callToAction = workspace?.callToAction ?? null;

	const openEditor = () => {
		if (!user.isPro && !callToAction) {
			setUpgradeModalOpen(true);
			return;
		}
		setDialogMounted(true);
		setDialogOpen(true);
	};

	const coverage = workspace ? (
		workspace.includeExisting ? (
			"Shown on every video that doesn't have its own."
		) : (
			<>
				Shown on videos made since{" "}
				<time dateTime={workspace.enabledAt} suppressHydrationWarning>
					{new Date(workspace.enabledAt).toLocaleDateString(undefined, {
						day: "numeric",
						month: "short",
						year: "numeric",
					})}
				</time>
				.
			</>
		)
	) : null;

	return (
		<SettingsSection title="Call to action">
			<SettingsCard>
				<SettingsRow
					icon={<MousePointer2 className="size-[18px] text-gray-10" />}
					title="Default call to action"
					meta={<ProChip />}
					description={
						callToAction ? (
							<>
								Links to {callToActionDestinationLabel(callToAction.url)}.{" "}
								{coverage}
							</>
						) : (
							"Add a button to new videos in this workspace. Owners can change it or turn it off on any video."
						)
					}
					control={
						callToAction ? (
							<>
								<span
									className="inline-flex items-center px-3 h-8 max-w-48 text-[13px] font-semibold rounded-full truncate"
									style={{
										background: callToAction.color,
										color: readableTextColor(callToAction.color),
									}}
								>
									<span className="truncate">{callToAction.label}</span>
								</span>
								<button
									type="button"
									onClick={openEditor}
									className={pillButtonClass}
								>
									Edit
								</button>
							</>
						) : (
							<button
								type="button"
								onClick={openEditor}
								className={pillButtonClass}
							>
								Set up
							</button>
						)
					}
				/>
			</SettingsCard>
			{dialogMounted && (
				<CallToActionDialog
					open={dialogOpen}
					onOpenChange={setDialogOpen}
					target={{
						kind: "workspace",
						organizationId,
						includeExisting: workspace?.includeExisting ?? false,
					}}
					callToAction={callToAction}
					onSaved={() => router.refresh()}
					onUpgradeRequest={() => setUpgradeModalOpen(true)}
					brandColor={playerColorFromOrganizationMetadata(
						activeOrganization?.organization.metadata,
					)}
				/>
			)}
		</SettingsSection>
	);
}
