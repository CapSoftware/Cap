import { useDashboardContext } from "@/app/(org)/dashboard/Contexts";
import { Tooltip } from "@/components/Tooltip";
import { Button } from "@cap/ui";
import { faCheck } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Fit, Layout, useRive } from "@rive-app/react-canvas";
import clsx from "clsx";
import Link from "next/link";
import { memo } from "react";

export const UsageButton = memo(
  ({
    subscribed,
    toggleMobileNav,
  }: {
    subscribed: boolean;
    toggleMobileNav?: () => void;
  }) => {
    const { sidebarCollapsed } = useDashboardContext();
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
                  ? "p-0 w-10 h-10 rounded-full min-w-[unset] max-w-10"
                  : "w-full"
              )}
              variant="blue"
            >
              <FontAwesomeIcon
                className={clsx(
                  "text-white size-4",
                  sidebarCollapsed ? "mr-0" : "mr-1"
                )}
                icon={faCheck}
              />
              {sidebarCollapsed ? null : <p className="text-white">Cap Pro</p>}
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
          <ProRiveButton toggleMobileNav={toggleMobileNav} />
        </Tooltip>
      </>
    );
  }
);

const ProRiveButton = memo(
  ({ toggleMobileNav }: { toggleMobileNav?: () => void }) => {
    const { setUpgradeModalOpen, sidebarCollapsed } = useDashboardContext();

    const { rive, RiveComponent: ProRive } = useRive({
      src: "/rive/pricing.riv",
      artboard: "pro",
      animations: "idle",
      autoplay: false,
      layout: new Layout({
        fit: Fit.Cover,
      }),
    });

    return (
      <Button
        variant="blue"
        size="lg"
        onMouseEnter={() => {
          if (rive) {
            rive.stop();
            rive.play("items-coming-out");
          }
        }}
        onMouseLeave={() => {
          if (rive) {
            rive.stop();
            rive.play("items-coming-in");
          }
        }}
        className={clsx(
          "flex overflow-visible relative gap-3 justify-evenly items-center cursor-pointer",
          "mx-auto",
          sidebarCollapsed ? "py-0 h-10 min-w-[unset]" : "py-3 w-full h-fit"
        )}
        onClick={() => {
          setUpgradeModalOpen(true);
          toggleMobileNav?.();
        }}
      >
        <ProRive
          className={clsx(
            sidebarCollapsed
              ? "bottom-[4px] h-10 absolute w-[68px]"
              : "absolute w-[90px] h-[66px] bottom-[-3px] left-[-20px]",
            "scale-[0.8]"
          )}
        />
        {!sidebarCollapsed ? (
          <p className="relative left-8 text-center text-white truncate">
            Upgrade to Pro
          </p>
        ) : null}
      </Button>
    );
  }
);
