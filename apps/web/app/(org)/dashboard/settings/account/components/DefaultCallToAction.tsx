"use client";

import { Button, Card, CardDescription, CardTitle } from "@cap/ui";
import { ArrowUpRight } from "lucide-react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
	callToActionDestinationLabel,
	parseDefaultCallToAction,
	readableTextColor,
} from "@/lib/share-call-to-action";
import { useDashboardContext } from "../../../Contexts";

const CallToActionDialog = dynamic(
	() =>
		import(
			"@/app/s/[videoId]/_components/call-to-action/CallToActionDialog"
		).then((m) => m.CallToActionDialog),
	{ ssr: false },
);

export function DefaultCallToAction() {
	const router = useRouter();
	const { user, userPreferences, setUpgradeModalOpen } = useDashboardContext();
	const [dialogOpen, setDialogOpen] = useState(false);
	const [dialogMounted, setDialogMounted] = useState(false);
	const defaultCallToAction = parseDefaultCallToAction(userPreferences);

	const openDialog = () => {
		if (!user.isPro) {
			setUpgradeModalOpen(true);
			return;
		}
		setDialogMounted(true);
		setDialogOpen(true);
	};

	return (
		<Card className="flex flex-col gap-4">
			<div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
				<div className="space-y-1">
					<CardTitle>Default call to action</CardTitle>
					<CardDescription>
						Shown on every video of yours that doesn't have its own call to
						action, including ones you've already shared. You can turn it off
						for a single video from that video's Call to action menu.
					</CardDescription>
				</div>
				<Button
					type="button"
					size="sm"
					variant={defaultCallToAction ? "gray" : "dark"}
					className="shrink-0"
					onClick={openDialog}
				>
					{defaultCallToAction ? "Edit" : "Set default"}
					{!user.isPro && <span className="ml-1.5 opacity-70">Pro</span>}
				</Button>
			</div>

			{defaultCallToAction && (
				<div className="flex min-w-0 items-center gap-3 rounded-xl border border-gray-4 bg-gray-2 p-3">
					<span
						className="inline-flex shrink-0 items-center gap-1 rounded-full px-3 py-1.5 text-[13px] font-semibold"
						style={{
							background: defaultCallToAction.color,
							color: readableTextColor(defaultCallToAction.color),
						}}
					>
						{defaultCallToAction.label}
						<ArrowUpRight className="size-3.5" />
					</span>
					<span className="min-w-0 truncate text-[13px] text-gray-10">
						{defaultCallToAction.headline
							? `${defaultCallToAction.headline} · `
							: ""}
						{callToActionDestinationLabel(defaultCallToAction.url)}
					</span>
				</div>
			)}

			{dialogMounted && (
				<CallToActionDialog
					open={dialogOpen}
					onOpenChange={setDialogOpen}
					callToAction={defaultCallToAction}
					onSaved={() => router.refresh()}
					onUpgradeRequest={() => setUpgradeModalOpen(true)}
				/>
			)}
		</Card>
	);
}
