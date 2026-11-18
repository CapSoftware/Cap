"use client";

import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@cap/ui";
import { faArrowDownWideShort } from "@fortawesome/free-solid-svg-icons/faArrowDownWideShort";
import { faArrowUpWideShort } from "@fortawesome/free-solid-svg-icons/faArrowUpWideShort";
import { faCheck } from "@fortawesome/free-solid-svg-icons/faCheck";
import { faChevronDown } from "@fortawesome/free-solid-svg-icons/faChevronDown";
import { faGripVertical } from "@fortawesome/free-solid-svg-icons/faGripVertical";
import clsx from "clsx";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";
import { setSpaceVideoOrder } from "@/actions/spaces/video-order";
import { FontAwesomeIcon } from "@/components/FontAwesomeIcon";
import {
	SPACE_VIDEO_ORDER_OPTIONS,
	type SpaceVideoOrder,
} from "@/lib/space-video-order";
import { listControlClass } from "../../../caps/components/CapListHeader";

const ORDER_ICONS: Record<SpaceVideoOrder, typeof faCheck> = {
	newest: faArrowDownWideShort,
	oldest: faArrowUpWideShort,
	custom: faGripVertical,
};

export function SpaceOrderSelect({
	spaceId,
	order,
}: {
	spaceId: string;
	order: SpaceVideoOrder;
}) {
	const router = useRouter();
	const [isPending, startTransition] = useTransition();
	const active =
		SPACE_VIDEO_ORDER_OPTIONS.find((option) => option.value === order) ??
		SPACE_VIDEO_ORDER_OPTIONS[0];

	const choose = (next: SpaceVideoOrder) => {
		if (next === order) return;
		startTransition(async () => {
			try {
				await setSpaceVideoOrder(spaceId, next);
			} catch {
				toast.error("Couldn't change the order. Please try again.");
				return;
			}
			router.refresh();
			if (next === "custom")
				toast.success("Custom order is on. Drag Caps to arrange them.");
		});
	};

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					aria-label={`Order for everyone: ${active?.label}`}
					disabled={isPending}
					className={clsx(listControlClass, "gap-2 px-3")}
				>
					<FontAwesomeIcon
						icon={ORDER_ICONS[order]}
						className="size-3.5 text-gray-10"
					/>
					<span>{active?.label}</span>
					<FontAwesomeIcon
						icon={faChevronDown}
						className="size-2.5 text-gray-9"
					/>
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="min-w-52">
				<p className="px-2 pt-1 pb-1.5 text-xs text-gray-10">
					Sets the order for everyone in this space
				</p>
				{SPACE_VIDEO_ORDER_OPTIONS.map((option) => (
					<DropdownMenuItem
						key={option.value}
						onClick={() => choose(option.value)}
						className={clsx(
							"gap-2 rounded-lg",
							option.value === order && "text-gray-12",
						)}
					>
						<FontAwesomeIcon
							icon={ORDER_ICONS[option.value]}
							className="size-3 text-gray-10"
						/>
						<span className="flex-1">{option.label}</span>
						{option.value === order && (
							<FontAwesomeIcon icon={faCheck} className="size-3 text-gray-12" />
						)}
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
