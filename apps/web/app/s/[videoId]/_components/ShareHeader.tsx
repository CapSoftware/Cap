import { Button, LogoBadge } from "@cap/ui";
import { videos } from "@cap/database/schema";
import moment from "moment";
import { userSelectProps } from "@cap/database/auth/session";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "react-hot-toast";
import { LinkIcon, Loader2 } from "lucide-react";
import JSZip from "jszip";
import { saveAs } from "file-saver";

export const ShareHeader = ({
  data,
  user,
  individualFiles,
}: {
  data: typeof videos.$inferSelect;
  user: typeof userSelectProps | null;
  individualFiles: {
    fileName: string;
    url: string;
  }[];
}) => {
  const { push, refresh } = useRouter();
  const [isEditing, setIsEditing] = useState(false);
  const [title, setTitle] = useState(data.name);
  const [isDownloading, setIsDownloading] = useState(false);

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

    if (response.status === 429) {
      toast.error("Too many requests - please try again later.");
      return;
    }

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

  const downloadZip = async () => {
    setIsDownloading(true);
    const zip = new JSZip();

    try {
      for (const file of individualFiles) {
        const response = await fetch(file.url);
        const blob = await response.blob();
        zip.file(file.fileName, blob);
      }

      const content = await zip.generateAsync({ type: "blob" });
      saveAs(content, `${data.id}.zip`);
    } catch (error) {
      console.error("Error downloading zip:", error);
      toast.error("Failed to download files. Please try again.");
    } finally {
      setIsDownloading(false);
    }
  };

  return (
    <>
      <div>
        <div className="md:flex md:items-center md:justify-between space-x-0 md:space-x-6">
          <div className="md:flex items-center md:justify-between md:space-x-6">
            <div className="mb-3 md:mb-0">
              <div className="flex items-center space-x-3">
                {isEditing ? (
                  <input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    onBlur={handleBlur}
                    onKeyDown={handleKeyDown}
                    autoFocus
                    className="text-xl sm:text-2xl font-semibold"
                  />
                ) : (
                  <h1
                    className="text-xl sm:text-2xl"
                    onClick={() => {
                      if (
                        user !== null &&
                        user.id.toString() === data.ownerId
                      ) {
                        setIsEditing(true);
                      }
                    }}
                  >
                    {title}
                  </h1>
                )}
                <div>
                  <button
                    data-tooltip-id="clipboard"
                    data-tooltip-content="Copy link to clipboard"
                    className="bg-white p-2 w-8 h-8 rounded-lg flex items-center justify-center border hover:border-gray-300 transition-all"
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
              <p className="text-gray-400 text-sm">
                {moment(data.createdAt).fromNow()}
              </p>
            </div>
          </div>
          {(user !== null ||
            (individualFiles && individualFiles.length > 0)) && (
            <div className="flex items-center space-x-2">
              {individualFiles && individualFiles.length > 0 && (
                <div>
                  <Button
                    variant="gray"
                    onClick={downloadZip}
                    disabled={isDownloading}
                  >
                    {isDownloading ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Downloading...
                      </>
                    ) : (
                      "Download Assets"
                    )}
                  </Button>
                </div>
              )}
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
          )}
        </div>
      </div>
    </>
  );
};
