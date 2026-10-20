"use client";

import type { Organisation } from "@cap/web-domain";
import clsx from "clsx";
import { ChevronLeft, Folder, LayoutGrid, Users } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { updateActiveOrganization } from "@/app/(org)/dashboard/_components/Navbar/server";
import type { ShareDashboardDestination } from "@/lib/share-dashboard-destination";

const DESTINATION_ICONS = {
	caps: LayoutGrid,
	folder: Folder,
	space: Users,
	organization: Users,
} satisfies Record<ShareDashboardDestination["kind"], unknown>;

export function DashboardBackLink({
	destination,
	compact = false,
	className,
}: {
	destination: ShareDashboardDestination;
	compact?: boolean;
	className?: string;
}) {
	const router = useRouter();
	const [isSwitching, setIsSwitching] = useState(false);
	const Icon = DESTINATION_ICONS[destination.kind];
	const accessibleLabel = `Back to ${destination.label}`;
	const { switchOrganizationId } = destination;

	const classes = clsx(
		compact
			? "flex size-8 shrink-0 items-center justify-center rounded-full border border-gray-5 bg-gray-2 text-gray-11 hover:bg-gray-4"
			: "group inline-flex h-8 min-w-0 max-w-full items-center gap-1.5 rounded-full py-1 pl-1.5 pr-3 text-[13px] text-gray-11 hover:bg-gray-3",
		"transition-colors hover:text-gray-12 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-9 disabled:cursor-wait disabled:opacity-70",
		className,
	);

	const content = compact ? (
		<ChevronLeft className="size-4" aria-hidden />
	) : (
		<>
			<ChevronLeft
				className="size-4 shrink-0 transition-transform duration-200 group-hover:-translate-x-0.5"
				aria-hidden
			/>
			<Icon className="size-3.5 shrink-0 text-gray-10" aria-hidden />
			<span className="truncate">{destination.label}</span>
		</>
	);

	// A plain link would let a new tab skip the switch and open the dashboard
	// in an organization that doesn't hold this Cap.
	if (switchOrganizationId) {
		const switchAndGoBack = async () => {
			setIsSwitching(true);
			try {
				await updateActiveOrganization(
					switchOrganizationId as Organisation.OrganisationId,
				);
			} catch (error) {
				console.error("Failed to switch organization", error);
				toast.error("Couldn't open your dashboard. Please try again.");
				setIsSwitching(false);
				return;
			}
			router.push(destination.href);
		};

		return (
			<button
				type="button"
				onClick={switchAndGoBack}
				disabled={isSwitching}
				aria-label={accessibleLabel}
				title={compact ? accessibleLabel : undefined}
				className={classes}
			>
				{content}
			</button>
		);
	}

	return (
		<Link
			href={destination.href}
			aria-label={accessibleLabel}
			title={compact ? accessibleLabel : undefined}
			className={classes}
		>
			{content}
		</Link>
	);
}
