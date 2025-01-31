import { serverEnv, clientEnv, NODE_ENV } from "@cap/env";
import { LinkIcon, Trash } from "lucide-react";
import { toast } from "react-hot-toast";
import { Tooltip } from "react-tooltip";

interface CapCardActionsProps {
  capId: string;
  onDelete: (videoId: string) => Promise<void>;
}

export const CapCardActions: React.FC<CapCardActionsProps> = ({
  capId,
  onDelete,
}) => {
  const copyLink = () => {
    const link =
      clientEnv.NEXT_PUBLIC_IS_CAP && NODE_ENV === "production"
        ? `https://cap.link/${capId}`
        : `${clientEnv.NEXT_PUBLIC_WEB_URL}/s/${capId}`;

    navigator.clipboard.writeText(link);
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
