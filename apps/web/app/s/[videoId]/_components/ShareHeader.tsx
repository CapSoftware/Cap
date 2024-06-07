import { Button, LogoBadge } from "@cap/ui";
import { videos } from "@cap/database/schema";
import moment from "moment";
import { userSelectProps } from "@cap/database/auth/session";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "react-hot-toast";
import { LinkIcon } from "lucide-react";
import { Tooltip } from "react-tooltip";

export const ShareHeader = ({
  data,
  user,
}: {
  data: typeof videos.$inferSelect;
  user: typeof userSelectProps | null;
}) => {
  const { push, refresh } = useRouter();
  const [isEditing, setIsEditing] = useState(false);
  const [title, setTitle] = useState(data.name);

  const handleBlur = async () => {
    setIsEditing(false);
    const response = await fetch(
      `${process.env.NEXT_PUBLIC_URL}/api/video/title`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, videoId: data.id }),
      }
    );
    if (!response.ok) {
      toast.error("Failed to update title - please try again.");
      return;
    }

    toast.success("Video title updated");

    refresh();
  };

  const handleKeyDown = async (event: { key: string }) => {
    if (event.key === "Enter") {
      handleBlur();
    }
  };

  return (
    <>
      <Tooltip data-tooltip-id="clipboard" />
      <div>
        <div className="md:flex md:items-center md:justify-between space-x-0 md:space-x-6">
          <div className="flex items-center md:justify-between space-x-6">
            <div>
              <a
                href={
                  user
                    ? "/dashboard"
                    : `${process.env.NEXT_PUBLIC_URL}?referrer=${data.id}`
                }
              >
                <LogoBadge className="w-8 h-auto" />
              </a>
            </div>
            <div>
              {isEditing ? (
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  onBlur={handleBlur}
                  onKeyDown={handleKeyDown}
                  autoFocus
                  className="text-2xl font-semibold"
                />
              ) : (
                <h1
                  className="text-2xl"
                  onClick={() => {
                    if (user !== null && user.id.toString() === data.ownerId) {
                      setIsEditing(true);
                    }
                  }}
                >
                  {title}
                </h1>
              )}
              <p className="text-gray-400 text-sm">
                {moment(data.createdAt).fromNow()}
              </p>
            </div>
            <div>
              <button
                data-tooltip-id="clipboard"
                data-tooltip-content="Copy link to clipboard"
                className="bg-white p-2 w-8 h-8 rounded-lg flex items-center justify-center border hover:border-primary-3 transition-all"
                onClick={() => {
                  if (process.env.NEXT_PUBLIC_IS_CAP) {
                    navigator.clipboard.writeText(
                      `https://cap.link/${data.id}`
                    );
                  } else {
                    navigator.clipboard.writeText(
                      `${process.env.NEXT_PUBLIC_URL}/s/${data.id}`
                    );
                  }
                  toast.success("Link copied to clipboard!");
                }}
              >
                <LinkIcon className="w-5 h-5" />
              </button>
            </div>
          </div>
          {user !== null && (
            <div className="hidden md:flex">
              <Button
                onClick={() => {
                  push(`${process.env.NEXT_PUBLIC_URL}/dashboard`);
                }}
              >
                Go to Dashboard
              </Button>
            </div>
          )}
        </div>
      </div>
    </>
  );
};
