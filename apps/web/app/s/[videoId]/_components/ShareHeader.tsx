import { editTitle } from "@/actions/videos/edit-title";
import { UpgradeModal } from "@/components/UpgradeModal";
import { userSelectProps } from "@cap/database/auth/session";
import { videos } from "@cap/database/schema";
import { clientEnv, NODE_ENV } from "@cap/env";
import { Button } from "@cap/ui";
import { isUserOnProPlan } from "@cap/utils";
import { Copy, Globe2 } from "lucide-react";
import moment from "moment";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "react-hot-toast";

export const ShareHeader = ({
  data,
  user,
  customDomain,
  domainVerified,
}: {
  data: typeof videos.$inferSelect;
  user: typeof userSelectProps | null;
  customDomain: string | null;
  domainVerified: boolean;
}) => {
  const { push, refresh } = useRouter();
  const [isEditing, setIsEditing] = useState(false);
  const [title, setTitle] = useState(data.name);
  const [isDownloading, setIsDownloading] = useState(false);
  const [upgradeModalOpen, setUpgradeModalOpen] = useState(false);

  const handleBlur = async () => {
    setIsEditing(false);

    try {
      await editTitle(data.id, title);
      toast.success("Video title updated");
      refresh();
    } catch (error) {
      if (error instanceof Error) {
        toast.error(error.message);
      } else {
        toast.error("Failed to update title - please try again.");
      }
    }
  };

  const handleKeyDown = async (event: { key: string }) => {
    if (event.key === "Enter") {
      handleBlur();
    }
  };

  const getVideoLink = () => {
    return customDomain && domainVerified
      ? `https://${customDomain}/s/${data.id}`
      : clientEnv.NEXT_PUBLIC_IS_CAP && NODE_ENV === "production"
      ? `https://cap.link/${data.id}`
      : `${clientEnv.NEXT_PUBLIC_WEB_URL}/s/${data.id}`;
  };

  const getDisplayLink = () => {
    return customDomain && domainVerified
      ? `${customDomain}/s/${data.id}`
      : clientEnv.NEXT_PUBLIC_IS_CAP && NODE_ENV === "production"
      ? `cap.link/${data.id}`
      : `${clientEnv.NEXT_PUBLIC_WEB_URL}/s/${data.id}`;
  };

  const isUserPro = user
    ? isUserOnProPlan({
        subscriptionStatus: user.stripeSubscriptionStatus,
      })
    : false;

  return (
    <>
      <div>
        <div className="space-x-0 md:flex md:items-center md:justify-between md:space-x-6">
          <div className="items-center md:flex md:justify-between md:space-x-6">
            <div className="mb-3 md:mb-0">
              <div className="flex items-center space-x-3  lg:min-w-[400px]">
                {isEditing ? (
                  <input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    onBlur={handleBlur}
                    onKeyDown={handleKeyDown}
                    autoFocus
                    className="w-full text-xl font-semibold sm:text-2xl"
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
              </div>
              <p className="text-sm text-gray-10">
                {moment(data.createdAt).fromNow()}
              </p>
            </div>
          </div>
          {user !== null && (
            <div className="flex space-x-2">
              <div>
                <Button
                  variant="white"
                  onClick={() => {
                    navigator.clipboard.writeText(getVideoLink());
                    toast.success("Link copied to clipboard!");
                  }}
                >
                  {getDisplayLink()}
                  <Copy className="ml-2 w-4 h-4" />
                </Button>
                {user !== null && !isUserPro && (
                  <button
                    className="flex items-center mt-1 text-sm text-gray-400 cursor-pointer hover:text-blue-500"
                    onClick={() => setUpgradeModalOpen(true)}
                  >
                    <Globe2 className="mr-1 w-4 h-4" />
                    Connect a custom domain
                  </button>
                )}
              </div>
              {user !== null && (
                <div className="hidden md:flex">
                  <Button
                    onClick={() => {
                      push(`${clientEnv.NEXT_PUBLIC_WEB_URL}/dashboard`);
                    }}
                  >
                    <span className="hidden text-sm text-white lg:block">
                      Go to
                    </span>{" "}
                    Dashboard
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      <UpgradeModal
        open={upgradeModalOpen}
        onOpenChange={setUpgradeModalOpen}
      />
    </>
  );
};
