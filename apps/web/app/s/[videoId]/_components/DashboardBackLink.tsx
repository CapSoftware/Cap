import clsx from "clsx";
import { ChevronLeft, Folder, LayoutGrid, Users } from "lucide-react";
import Link from "next/link";
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
	const Icon = DESTINATION_ICONS[destination.kind];
	const accessibleLabel = `Back to ${destination.label}`;

	if (compact) {
		return (
			<Link
				href={destination.href}
				aria-label={accessibleLabel}
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
			aria-label={accessibleLabel}
			className={clsx(
				"group inline-flex h-8 min-w-0 max-w-full items-center gap-1.5 rounded-full py-1 pl-1.5 pr-3 text-[13px] text-gray-11 transition-colors hover:bg-gray-3 hover:text-gray-12 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-9",
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
