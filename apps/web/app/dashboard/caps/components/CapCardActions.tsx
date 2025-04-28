import { serverEnv, NODE_ENV } from "@cap/env";
import { LinkIcon, Trash } from "lucide-react";
import { toast } from "react-hot-toast";
import { Tooltip } from "react-tooltip";
import { useSharedContext } from "../../_components/DynamicSharedLayout";
interface CapCardActionsProps {
  capId: string;
  url: string;
  onDelete: (videoId: string) => Promise<void>;
}

export const CapCardActions = ({
  capId,
  url,
  onDelete,
}: CapCardActionsProps) => {
  const copyLink = () => {
    navigator.clipboard.writeText(url);
    toast.success("Link copied to clipboard!");
  };

  return (
    <div className="absolute top-2 right-2 space-y-2 z-20">
      <button
        type="button"
        className="cursor-pointer border border-gray-300 relative bg-white hover:bg-gray-200 w-8 h-8 m-0 p-0 rounded-full flex items-center justify-center transition-all"
        onClick={copyLink}
        data-tooltip-id={capId + "_copy"}
        data-tooltip-content="Copy shareable Cap link"
      >
        <LinkIcon className="w-4 h-4" />
        <Tooltip id={capId + "_copy"} />
      </button>
      <button
        type="button"
        className="cursor-pointer border border-gray-300 relative bg-white hover:bg-gray-200 w-8 h-8 m-0 p-0 rounded-full flex items-center justify-center transition-all"
        onClick={() => onDelete(capId)}
        data-tooltip-id={capId + "_delete"}
        data-tooltip-content="Delete your Cap recording"
      >
        <Trash className="w-4 h-4" />
        <Tooltip id={capId + "_delete"} />
      </button>
    </div>
  );
};
