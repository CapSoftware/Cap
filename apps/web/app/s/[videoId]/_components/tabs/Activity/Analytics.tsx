"use client";

import { use, useEffect, useMemo, useState } from "react";
import {
	getVideoAnalytics,
	getVideoEngagement,
} from "@/actions/videos/get-analytics";
import { CapCardAnalytics } from "@/app/(org)/dashboard/caps/components/CapCard/CapCardAnalytics";
import type { CommentType } from "../../../Share";

type EngagementData = Awaited<ReturnType<typeof getVideoEngagement>>;

const DropOffBar = ({
	label,
	count,
	total,
}: {
	label: string;
	count: number;
	total: number;
}) => {
	const pct = total > 0 ? Math.round((count / total) * 100) : 0;
	return (
		<div className="flex flex-col gap-0.5 min-w-0">
			<div className="flex justify-between items-center">
				<span className="text-[10px] text-gray-500">{label}</span>
				<span className="text-[10px] font-medium text-gray-700">{count}</span>
			</div>
			<div className="h-1 rounded-full bg-gray-100 overflow-hidden">
				<div
					className="h-full rounded-full bg-blue-500 transition-all"
					style={{ width: `${pct}%` }}
				/>
			</div>
		</div>
	);
};

const Analytics = (props: {
	videoId: string;
	views: MaybePromise<number>;
	comments: CommentType[];
	isLoadingAnalytics: boolean;
	isOwner: boolean;
}) => {
	const [views, setViews] = useState(
		props.views instanceof Promise ? use(props.views) : props.views,
	);
	const [engagement, setEngagement] = useState<EngagementData | null>(null);

	useEffect(() => {
		const fetchAnalytics = async () => {
			try {
				const result = await getVideoAnalytics(props.videoId);
				setViews(result.count);
			} catch (error) {
				console.error("Error fetching analytics:", error);
			}
		};

		fetchAnalytics();
	}, [props.videoId]);

	useEffect(() => {
		if (!props.isOwner) return;
		getVideoEngagement(props.videoId)
			.then(setEngagement)
			.catch(() => {});
	}, [props.videoId, props.isOwner]);

	const totalComments = useMemo(
		() => props.comments.filter((c) => c.type === "text").length,
		[props.comments],
	);

	const totalReactions = useMemo(
		() => props.comments.filter((c) => c.type === "emoji").length,
		[props.comments],
	);

	return (
		<div className="flex flex-col gap-3 w-full">
			<CapCardAnalytics
				isLoadingAnalytics={props.isLoadingAnalytics}
				capId={props.videoId}
				displayCount={views}
				totalComments={totalComments}
				totalReactions={totalReactions}
				isOwner={props.isOwner}
			/>
			{props.isOwner && engagement && engagement.total > 0 && (
				<div className="flex flex-col gap-2 pt-2 border-t border-gray-100">
					<div className="flex items-center justify-between">
						<span className="text-xs text-gray-500">Avg watched</span>
						<span className="text-xs font-semibold text-gray-800">
							{engagement.avgPercent}%
						</span>
					</div>
					<div className="grid grid-cols-4 gap-2">
						<DropOffBar
							label="25%"
							count={engagement.reached25}
							total={engagement.total}
						/>
						<DropOffBar
							label="50%"
							count={engagement.reached50}
							total={engagement.total}
						/>
						<DropOffBar
							label="75%"
							count={engagement.reached75}
							total={engagement.total}
						/>
						<DropOffBar
							label="95%"
							count={engagement.reached95}
							total={engagement.total}
						/>
					</div>
				</div>
			)}
		</div>
	);
};

export default Analytics;
