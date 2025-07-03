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
import { buildEnv } from "@cap/env";
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
  sharedSpaces = [],
  NODE_ENV,
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
  NODE_ENV: "production" | "development" | "test";
}) => {
  const { push, refresh } = useRouter();
  const [isEditing, setIsEditing] = useState(false);
  const [title, setTitle] = useState(data.name);
  const [upgradeModalOpen, setUpgradeModalOpen] = useState(false);
  const [isSharingDialogOpen, setIsSharingDialogOpen] = useState(false);

  const contextData = useDashboardContext();
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
    if (NODE_ENV === "development" && customDomain && domainVerified) {
      return `${customDomain}/s/${data.id}`;
    } else if (NODE_ENV === "development" && !customDomain && !domainVerified) {
      return `${webUrl}/s/${data.id}`;
    } else if (buildEnv.NEXT_PUBLIC_IS_CAP && customDomain && domainVerified) {
      return `${customDomain}/s/${data.id}`;
    } else if (buildEnv.NEXT_PUBLIC_IS_CAP && !customDomain && !domainVerified) {
      return `cap.link/${data.id}`;
    } else {
      return `${webUrl}/s/${data.id}`;
    }
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
            className={clsx(baseClassName, "cursor-pointer hover:text-gray-12")}
            onClick={() => setIsSharingDialogOpen(true)}
          >
            Not shared{" "}
            <FontAwesomeIcon className="ml-2 size-2.5" icon={faChevronDown} />
          </p>
        );
      } else {
        return (
          <p
            className={clsx(baseClassName, "cursor-pointer hover:text-gray-12")}
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
              <p className="mt-1 text-sm text-gray-10">
                {moment(data.createdAt).fromNow()}
              </p>
            </div>
          </div>
          {user !== null && (
            <div className="flex space-x-2">
              <div>
                <div className="flex gap-2 items-center">
                  {data.password && (
                    <FontAwesomeIcon
                      className="text-amber-600 size-4"
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
                    {getVideoLink()}
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
