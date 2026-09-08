"use client";

import type { ImageUpload } from "@cap/web-domain";
import clsx from "clsx";
import { memo } from "react";
import { SignedImageUrl } from "@/components/SignedImageUrl";
import { BranchAnchor, NODE_BASE_CLASS } from "./TimelineBranch";
import { NODE_SIZE } from "./timeline-constants";

export interface ClusterFace {
	id: string;
	name: string;
	image: ImageUpload.ImageUrl | null;
}

interface TimelineBranchClusterProps {
	id: string;
	left: string;
	stem: number;
	/** Pre-sliced to three by the layout pass; stable across hover renders. */
	faces: readonly ClusterFace[];
	total: number;
	timeLabel: string;
	delay: number;
	reduceMotion: boolean;
}

/**
 * A stack of comments that landed too close together to draw separately.
 * Widens with the number of faces, so it still reads as "several people" at a
 * glance without blowing past its neighbours.
 */
export const TimelineBranchCluster = memo(function TimelineBranchCluster({
	id,
	left,
	stem,
	faces,
	total,
	timeLabel,
	delay,
	reduceMotion,
}: TimelineBranchClusterProps) {
	const overflow = total - faces.length;
	const label = `${total} comments at ${timeLabel}`;

	return (
		<BranchAnchor
			left={left}
			stem={stem}
			delay={delay}
			reduceMotion={reduceMotion}
		>
			<button
				type="button"
				data-comment-id={id}
				data-timeline-node=""
				aria-label={label}
				title={label}
				className={clsx(
					NODE_BASE_CLASS,
					"h-[30px] gap-0 rounded-full bg-white px-1.5 ring-1 ring-gray-5",
					"shadow-[0_1px_3px_rgba(18,22,31,0.10)]",
				)}
				style={{ top: stem }}
			>
				{faces.map((face, index) => (
					<span
						key={face.id}
						className={clsx(
							"block overflow-hidden rounded-full ring-1 ring-white size-[22px]",
							index > 0 && "-ml-2.5",
						)}
						style={{ zIndex: faces.length - index }}
					>
						<SignedImageUrl
							image={face.image}
							name={face.name}
							className="size-full"
							letterClass="text-[10px] font-medium"
						/>
					</span>
				))}
				{overflow > 0 && (
					<span
						className="ml-1 rounded-full bg-gray-3 px-1 text-[11px] font-medium leading-5 tabular-nums text-gray-11"
						style={{ minWidth: NODE_SIZE / 2 }}
					>
						+{overflow}
					</span>
				)}
			</button>
		</BranchAnchor>
	);
});
