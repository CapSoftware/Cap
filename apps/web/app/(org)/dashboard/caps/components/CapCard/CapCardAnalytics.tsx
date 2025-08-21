import { faComment, faEye, faSmile } from "@fortawesome/free-solid-svg-icons";
import {
	FontAwesomeIcon,
	type FontAwesomeIconProps,
} from "@fortawesome/react-fontawesome";
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
}

export const CapCardAnalytics = Object.assign(
	({ displayCount, totalComments, totalReactions }: CapCardAnalyticsProps) => (
		<Shell>
			<Tooltip content={`${displayCount} unique views`}>
				<IconItem icon={faEye}>
					<span className="text-sm text-gray-12">{displayCount}</span>
				</IconItem>
			</Tooltip>
			<Tooltip content={`${totalComments} comments`}>
				<IconItem icon={faComment}>
					<span className="text-sm text-gray-12">{totalComments}</span>
				</IconItem>
			</Tooltip>
			<Tooltip content={`${totalReactions} reactions`}>
				<IconItem icon={faSmile}>
					<span className="text-sm text-gray-12">{totalReactions}</span>
				</IconItem>
			</Tooltip>
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
	<div className="flex flex-wrap gap-4 items-center text-sm text-gray-60">
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
