"use client";

import type { Organisation } from "@cap/web-domain";
import clsx from "clsx";
import { ChevronLeft, Folder, LayoutGrid, Users } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type MouseEvent, useState } from "react";
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

	const handleClick = async (event: MouseEvent<HTMLAnchorElement>) => {
		if (
			!switchOrganizationId ||
			event.button !== 0 ||
			event.metaKey ||
			event.ctrlKey ||
			event.shiftKey ||
			event.altKey
		) {
			return;
		}
		event.preventDefault();
		if (isSwitching) return;
		setIsSwitching(true);
		try {
			await updateActiveOrganization(
				switchOrganizationId as Organisation.OrganisationId,
			);
		} catch (error) {
			console.error("Failed to switch organization before going back", error);
		}
		router.push(destination.href);
	};

	if (compact) {
		return (
			<Link
				href={destination.href}
				onClick={handleClick}
				aria-label={accessibleLabel}
				aria-busy={isSwitching}
				title={accessibleLabel}
				className={clsx(
					"flex size-8 shrink-0 items-center justify-center rounded-full border border-gray-5 bg-gray-2 text-gray-11 transition-colors hover:bg-gray-4 hover:text-gray-12 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-9",
					className,
				)}
			>
				<ChevronLeft className="size-4" aria-hidden />
			</Link>
		);
	}

	return (
		<Link
			href={destination.href}
			onClick={handleClick}
			aria-label={accessibleLabel}
			aria-busy={isSwitching}
			className={clsx(
				"group inline-flex h-8 min-w-0 max-w-full items-center gap-1.5 rounded-full py-1 pl-1.5 pr-3 text-[13px] text-gray-11 transition-colors hover:bg-gray-3 hover:text-gray-12 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-9",
				isSwitching && "opacity-70",
				className,
			)}
		>
			<ChevronLeft
				className="size-4 shrink-0 transition-transform duration-200 group-hover:-translate-x-0.5"
				aria-hidden
			/>
			<Icon className="size-3.5 shrink-0 text-gray-10" aria-hidden />
			<span className="truncate">{destination.label}</span>
		</Link>
	);
}
