import { Tooltip } from "@/components/Tooltip";
import { Button } from "@cap/ui";
import { faArrowUp, faCheck } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import clsx from "clsx";
import Link from "next/link";
import { useState } from "react";
import { UpgradeModal } from "./UpgradeModal";

export const UsageButton = ({
  subscribed,
  collapsed,
}: {
  subscribed: boolean;
  collapsed: boolean;
}) => {
  const [upgradeModalOpen, setUpgradeModalOpen] = useState(false);

  if (subscribed) {
    return (
      <Tooltip position="right" content="Cap Pro">
        <Link
          className="flex justify-center mx-auto w-full"
          href="/dashboard/settings/workspace"
        >
          <Button
            size="lg"
            className={clsx(
              "overflow-hidden truncate",
              collapsed ? "p-0 w-10 h-10 rounded-full min-w-10" : "w-full"
            )}
            variant="primary"
          >
            <img
              src="/illustrations/cloud-1.png"
              className="absolute w-32 opacity-30 left-[-32px]"
            />
            <img
              src="/illustrations/cloud-2.png"
              className="absolute w-32 opacity-30 right-[-82px]"
            />
            <FontAwesomeIcon
              className={clsx(
                "text-gray-50 drop-shadow-[0_0_2px_rgba(255,255,255,0.5)]",
                collapsed ? "mr-0" : "mr-1"
              )}
              icon={faCheck}
            />
            {collapsed ? null : (
              <p className="text-gray-50 drop-shadow-[0_0_2px_rgba(255,255,255,0.5)]">
                Cap Pro
              </p>
            )}
          </Button>
        </Link>
      </Tooltip>
    );
  }

  return (
    <>
      <Tooltip position="right" content="Upgrade to Pro">
        <div className="flex justify-center mx-auto w-full">
          <Button
            size="lg"
            className={clsx(
              "overflow-hidden truncate",
              collapsed ? "p-0 w-10 h-10 rounded-full min-w-10" : "w-full"
            )}
            variant="primary"
            onClick={() => setUpgradeModalOpen(true)}
          >
            <img
              src="/illustrations/cloud-1.png"
              className="absolute w-32 opacity-30 left-[-32px]"
            />
            <img
              src="/illustrations/cloud-2.png"
              className="absolute w-32 opacity-30 right-[-82px]"
            />
            <FontAwesomeIcon
              className={clsx(
                "text-gray-50 drop-shadow-[0_0_2px_rgba(255,255,255,0.5)]",
                collapsed ? "mr-0" : "mr-1"
              )}
              icon={faArrowUp}
            />
            {collapsed ? null : (
              <p className="text-gray-50 drop-shadow-[0_0_2px_rgba(255,255,255,0.5)]">
                Upgrade to Pro
              </p>
            )}
          </Button>
        </div>
      </Tooltip>
      <UpgradeModal
        open={upgradeModalOpen}
        onOpenChange={setUpgradeModalOpen}
      />
    </>
  );
};
