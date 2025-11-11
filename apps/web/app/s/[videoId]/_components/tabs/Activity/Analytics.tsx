import { use, useMemo } from "react";
import { CapCardAnalytics } from "@/app/(org)/dashboard/caps/components/CapCard/CapCardAnalytics";
import type { CommentType } from "../../../Share";

const Analytics = (props: {
	videoId: string;
	views: MaybePromise<number>;
	comments: CommentType[];
}) => {
	const views =
		typeof props.views === "number" ? props.views : use(props.views);

	const totalComments = useMemo(
		() => props.comments.filter((c) => c.type === "text").length,
		[props.comments],
	);

	const totalReactions = useMemo(
		() => props.comments.filter((c) => c.type === "emoji").length,
		[props.comments],
	);

	return (
		<CapCardAnalytics
			isLoadingAnalytics={false}
			capId={props.videoId}
			displayCount={views}
			totalComments={totalComments}
			totalReactions={totalReactions}
		/>
	);
};

export default Analytics;
