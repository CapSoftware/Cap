"use client";

import { Button } from "@cap/ui";
import { videos } from "@cap/database/schema";
import moment from "moment";
import { userSelectProps } from "@cap/database/auth/session";
import { faChevronDown, faLock } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useRouter } from "next/navigation";
import { useState, useEffect } from "react";
import { toast } from "sonner";
import { Copy, Globe2 } from "lucide-react";
import { buildEnv, NODE_ENV } from "@cap/env";
import { editTitle } from "@/actions/videos/edit-title";
import { usePublicEnv } from "@/utils/public-env";
import { isUserOnProPlan } from "@cap/utils";
import { UpgradeModal } from "@/components/UpgradeModal";
import clsx from "clsx";
import { useDashboardContext } from "@/app/(org)/dashboard/Contexts";
import { SharingDialog } from "@/app/(org)/dashboard/caps/components/SharingDialog";

export const ShareHeader = ({
  data,
  user,
  customDomain,
  domainVerified,
  sharedOrganizations = [],
  userOrganizations = [],
  sharedSpaces = [],
  userSpaces = [],
}: {
  data: typeof videos.$inferSelect;
  user: typeof userSelectProps | null;
  customDomain?: string | null;
  domainVerified?: boolean;
  sharedOrganizations?: { id: string; name: string }[];
  userOrganizations?: { id: string; name: string }[];
  sharedSpaces?: {
    id: string;
    name: string;
    iconUrl?: string;
    organizationId: string;
  }[];
  userSpaces?: {
    id: string;
    name: string;
    iconUrl?: string;
    organizationId: string;
  }[];
}) => {
  const { push, refresh } = useRouter();
  const [isEditing, setIsEditing] = useState(false);
  const [title, setTitle] = useState(data.name);
  const [isDownloading, setIsDownloading] = useState(false);
  const [upgradeModalOpen, setUpgradeModalOpen] = useState(false);
  const [isSharingDialogOpen, setIsSharingDialogOpen] = useState(false);

  const contextData = useDashboardContext();
  const contextSpaces = contextData?.spacesData || null;
  const contextSharedSpaces = contextData?.sharedSpaces || null;
  const effectiveSharedSpaces = contextSharedSpaces || sharedSpaces;

  const isOwner = user && user.id.toString() === data.ownerId;

  const { webUrl } = usePublicEnv();

  useEffect(() => {
    setTitle(data.name);
  }, [data.name]);

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
      : buildEnv.NEXT_PUBLIC_IS_CAP && NODE_ENV === "production"
      ? `https://cap.link/${data.id}`
      : `${webUrl}/s/${data.id}`;
  };

  const getDisplayLink = () => {
    return customDomain && domainVerified
      ? `${customDomain}/s/${data.id}`
      : buildEnv.NEXT_PUBLIC_IS_CAP && NODE_ENV === "production"
      ? `cap.link/${data.id}`
      : `${webUrl}/s/${data.id}`;
  };

  const isUserPro = user
    ? isUserOnProPlan({
        subscriptionStatus: user.stripeSubscriptionStatus,
      })
    : false;

  const handleSharingUpdated = () => {
    refresh();
  };

  const renderSharedStatus = () => {
    const baseClassName =
      "text-sm text-gray-10 transition-colors duration-200 flex items-center";

    if (isOwner) {
      if (
        (sharedOrganizations?.length === 0 || !sharedOrganizations) &&
        (effectiveSharedSpaces?.length === 0 || !effectiveSharedSpaces)
      ) {
        return (
          <p
            className={clsx(baseClassName, "hover:text-gray-12 cursor-pointer")}
            onClick={() => setIsSharingDialogOpen(true)}
          >
            Not shared{" "}
            <FontAwesomeIcon className="ml-2 size-2.5" icon={faChevronDown} />
          </p>
        );
      } else {
        return (
          <p
            className={clsx(baseClassName, "hover:text-gray-12 cursor-pointer")}
            onClick={() => setIsSharingDialogOpen(true)}
          >
            Shared{" "}
            <FontAwesomeIcon className="ml-1 size-2.5" icon={faChevronDown} />
          </p>
        );
      }
    } else {
      return <p className={baseClassName}>Shared with you</p>;
    }
  };

  return (
    <>
      <SharingDialog
        isOpen={isSharingDialogOpen}
        onClose={() => setIsSharingDialogOpen(false)}
        capId={data.id}
        capName={data.name}
        sharedSpaces={effectiveSharedSpaces || []}
        onSharingUpdated={handleSharingUpdated}
      />
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
                      if (user && user.id.toString() === data.ownerId) {
                        setIsEditing(true);
                      }
                    }}
                  >
                    {title}
                  </h1>
                )}
              </div>
              {user && renderSharedStatus()}
              <p className="text-sm text-gray-10 mt-1">
                {moment(data.createdAt).fromNow()}
              </p>
            </div>
          </div>
          {user !== null && (
            <div className="flex space-x-2">
              <div>
                <div className="flex items-center gap-2">
                  {data.password && (
                    <FontAwesomeIcon
                      className="size-4 text-amber-600"
                      icon={faLock}
                    />
                  )}
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
                </div>
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
                      push("/dashboard");
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
