import { EyeIcon, MessageSquareIcon, SmileIcon } from "lucide-react";
import { Tooltip } from "react-tooltip";

interface CapCardAnalyticsProps {
  capId: string;
  displayCount: number;
  totalComments: number;
  totalReactions: number;
}

export const CapCardAnalytics: React.FC<CapCardAnalyticsProps> = ({
  capId,
  displayCount,
  totalComments,
  totalReactions,
}) => {
  return (
    <div className="flex items-center space-x-3 text-sm text-gray-60">
      <div
        className="flex items-center"
        data-tooltip-id={capId + "_analytics"}
        data-tooltip-content={`${displayCount} unique views via your shareable Cap.link.`}
      >
        <EyeIcon className="w-4 h-4 mr-1 text-gray-400" />
        <span className="text-[0.875rem] leading-[1.25rem] text-gray-400">
          {displayCount ?? "-"}
        </span>
        <Tooltip id={capId + "_analytics"} />
      </div>
      <div
        className="flex items-center"
        data-tooltip-id={capId + "_comments"}
        data-tooltip-content={`${totalComments} comments`}
      >
        <MessageSquareIcon className="w-4 h-4 mr-1 text-gray-400" />
        <span className="text-[0.875rem] leading-[1.25rem] text-gray-400">
          {totalComments}
        </span>
        <Tooltip id={capId + "_comments"} />
      </div>
      <div
        className="flex items-center"
        data-tooltip-id={capId + "_reactions"}
        data-tooltip-content={`${totalReactions} reactions`}
      >
        <SmileIcon className="w-4 h-4 mr-1 text-gray-400" />
        <span className="text-[0.875rem] leading-[1.25rem] text-gray-400">
          {totalReactions}
        </span>
        <Tooltip id={capId + "_reactions"} />
      </div>
    </div>
  );
};
