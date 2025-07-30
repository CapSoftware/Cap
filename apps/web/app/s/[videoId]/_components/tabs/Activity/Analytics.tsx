"use client";

import { getVideoAnalytics } from "@/actions/videos/get-analytics";
import { CapCardAnalytics } from "@/app/(org)/dashboard/caps/components/CapCard/CapCardAnalytics";
import { CommentType } from "../../../Share";
import { useState, useEffect, useMemo, use } from "react";

const Analytics = (props: {
  videoId: string;
  views: MaybePromise<number>;
  comments: CommentType[];
}) => {
  const [views, setViews] = useState(
    props.views instanceof Promise ? use(props.views) : props.views
  );

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

  const totalComments = useMemo(
    () => props.comments.filter((c) => c.type === "text").length,
    [props.comments]
  );

  const totalReactions = useMemo(
    () => props.comments.filter((c) => c.type === "emoji").length,
    [props.comments]
  );

  return (
    <CapCardAnalytics
      capId={props.videoId}
      displayCount={views}
      totalComments={totalComments}
      totalReactions={totalReactions}
    />
  );
}

export default Analytics;

