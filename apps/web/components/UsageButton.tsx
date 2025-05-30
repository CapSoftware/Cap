import { useSharedContext } from "@/app/dashboard/_components/DynamicSharedLayout";
import { Tooltip } from "@/components/Tooltip";
import { Button } from "@cap/ui";
import { faArrowUp, faCheck } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import clsx from "clsx";
import Link from "next/link";

export const UsageButton = ({
  subscribed,
  toggleMobileNav,
}: {
  subscribed: boolean;
  toggleMobileNav?: () => void;
}) => {
  const { sidebarCollapsed, setUpgradeModalOpen } = useSharedContext();

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
              sidebarCollapsed
                ? "p-0 w-10 h-10 rounded-full min-w-10"
                : "w-full"
            )}
            variant="primary"
          >
            <FontAwesomeIcon
              className={clsx(
                "text-gray-50",
                sidebarCollapsed ? "mr-0" : "mr-1"
              )}
              icon={faCheck}
            />
            {sidebarCollapsed ? null : <p className="text-gray-50">Cap Pro</p>}
          </Button>
        </Link>
      </Tooltip>
    );
  }

  return (
    <>
      <Tooltip
        disable={!sidebarCollapsed}
        position="right"
        content="Upgrade to Pro"
      >
        <div className="flex justify-center mx-auto w-full">
          <Button
            size="sm"
            className={clsx(
              "overflow-hidden truncate",
              sidebarCollapsed
                ? "p-0 w-10 h-10 rounded-full min-w-10"
                : "px-5 w-fit"
            )}
            variant="blue"
            onClick={() => {
              setUpgradeModalOpen(true);
              toggleMobileNav?.();
            }}
          >
            <FontAwesomeIcon
              className={clsx(
                "text-white size-4",
                sidebarCollapsed ? "mr-0" : null
              )}
              icon={faArrowUp}
            />
            {sidebarCollapsed ? null : "Upgrade to Pro"}
          </Button>
        </div>
      </Tooltip>
      {/* UpgradeModal is now rendered at the root level in DynamicSharedLayout */}
    </>
  );
};
