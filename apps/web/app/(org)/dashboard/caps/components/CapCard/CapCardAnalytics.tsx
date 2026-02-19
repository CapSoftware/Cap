import { faComment, faEye, faSmile } from "@fortawesome/free-solid-svg-icons";
import {
	FontAwesomeIcon,
	type FontAwesomeIconProps,
} from "@fortawesome/react-fontawesome";
import Link from "next/link";
import {
	type ComponentProps,
	type ForwardedRef,
	forwardRef,
	type PropsWithChildren,
} from "react";
import { Tooltip } from "@/components/Tooltip";

interface CapCardAnalyticsProps {
	capId: string;
	displayCount: number;
	totalComments: number;
	isLoadingAnalytics: boolean;
	totalReactions: number;
	isOwner?: boolean;
	isStudioPending?: boolean;
}

export const CapCardAnalytics = Object.assign(
	({
		capId,
		displayCount,
		totalComments,
		totalReactions,
		isLoadingAnalytics,
		isOwner = true,
		isStudioPending = false,
	}: CapCardAnalyticsProps) =>
		isLoadingAnalytics ? (
			<CapCardAnalytics.Skeleton />
		) : (
			<Shell>
				<div className="flex flex-wrap gap-4 items-center">
					<Tooltip
						content="View analytics"
						className="bg-gray-12 text-gray-1 border-gray-11 shadow-lg"
						delayDuration={100}
					>
						<Link
							href={`/dashboard/analytics?capId=${capId}`}
							className="inline-flex cursor-pointer"
						>
							<IconItem icon={faEye}>
								<span className="text-sm text-gray-12">{displayCount}</span>
							</IconItem>
						</Link>
					</Tooltip>
					<Tooltip
						content="View analytics"
						className="bg-gray-12 text-gray-1 border-gray-11 shadow-lg"
						delayDuration={100}
					>
						<Link
							href={`/dashboard/analytics?capId=${capId}`}
							className="inline-flex cursor-pointer"
						>
							<IconItem icon={faComment}>
								<span className="text-sm text-gray-12">{totalComments}</span>
							</IconItem>
						</Link>
					</Tooltip>
					<Tooltip
						content="View analytics"
						className="bg-gray-12 text-gray-1 border-gray-11 shadow-lg"
						delayDuration={100}
					>
						<Link
							href={`/dashboard/analytics?capId=${capId}`}
							className="inline-flex cursor-pointer"
						>
							<IconItem icon={faSmile}>
								<span className="text-sm text-gray-12">{totalReactions}</span>
							</IconItem>
						</Link>
					</Tooltip>
				</div>
				{isOwner &&
					(isStudioPending ? (
						<Link
							href={`/editor/${capId}`}
							className="text-xs text-blue-600 hover:underline"
						>
							Go to editor
						</Link>
					) : (
						<Link
							href={`/dashboard/analytics?capId=${capId}`}
							target="_blank"
							rel="noopener noreferrer"
							className="text-xs text-blue-600 hover:underline"
						>
							View analytics
						</Link>
					))}
			</Shell>
		),
	{
		Skeleton: () => (
			<Shell>
				<SkeletonItem icon={faEye} />
				<SkeletonItem icon={faComment} />
				<SkeletonItem icon={faSmile} />
			</Shell>
		),
	},
);

const Shell = (props: PropsWithChildren) => (
	<div className="flex flex-wrap gap-4 items-center justify-between text-sm text-gray-60">
		{props.children}
	</div>
);

const IconItem = forwardRef(
	(
		props: { icon: FontAwesomeIconProps["icon"] } & Pick<
			ComponentProps<"div">,
			"children"
		>,
		ref: ForwardedRef<HTMLDivElement>,
	) => (
		<div ref={ref} className="flex gap-2 items-center">
			<FontAwesomeIcon className="text-gray-8 size-4" icon={props.icon} />
			{props.children}
		</div>
	),
);

const SkeletonItem = ({ icon }: { icon: FontAwesomeIconProps["icon"] }) => (
	<IconItem icon={icon}>
		<div className="h-1.5 w-3 -mx-0.5 bg-gray-5 rounded-full animate-pulse" />
	</IconItem>
);
