"use client";
import { Tooltip } from "@/components/Tooltip";
import { Button, Logo } from "@cap/ui";
import clsx from "clsx";
import { motion } from "framer-motion";
import { useDetectPlatform } from "hooks/useDetectPlatform";
import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";
import AdminNavItems from "./Items";
import { useDashboardContext } from "../../Contexts";

export const DesktopNav = () => {
  const { toggleSidebarCollapsed, sidebarCollapsed } = useDashboardContext();
  const { platform } = useDetectPlatform();
  const cmdSymbol = platform === "macos" ? "⌘" : "Ctrl";

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === "s" &&
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey
      ) {
        event.preventDefault();
        toggleSidebarCollapsed();
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [toggleSidebarCollapsed]);

  return (
    <>
      <motion.div
        initial={{
          width: sidebarCollapsed ? "70px" : "230px",
        }}
        animate={{
          width: sidebarCollapsed ? "70px" : "230px",
          transition: {
            duration: 0.6,
            type: "spring",
            bounce: 0.25,
          },
        }}
        className={clsx("hidden z-50 h-full lg:flex group", "relative")}
      >
        <div className="flex flex-col w-full max-w-[220px] mx-auto h-full">
          <div className="flex justify-start items-center px-3 pt-5 mb-3.5 w-full truncate min-h-8">
            <Link href="/dashboard">
              <Logo
                hideLogoName={sidebarCollapsed}
                className="mx-auto w-[120px] h-[40px]"
              />
            </Link>
          </div>

          <div className="flex overflow-y-auto flex-col flex-grow">
            <div className="flex flex-col px-3 h-full">
              <AdminNavItems />
            </div>
          </div>

          <Tooltip
            kbd={[cmdSymbol, "Shift", "S"]}
            position="right"
            content="Toggle collapse"
          >
            <Button
              variant="dark"
              onClick={toggleSidebarCollapsed}
              className="absolute right-[-12px] size-7 p-0 min-w-[unset] hover:border-gray-3 hover:bg-gray-2 top-[50%] transform -translate-y-1/2 rounded-full border bg-gray-1 border-gray-3 transition-colors z-10"
            >
              <ChevronRight
                size={14}
                className={clsx(
                  "transition-transform duration-200 text-gray-12",
                  sidebarCollapsed ? "rotate-180" : ""
                )}
              />
            </Button>
          </Tooltip>
        </div>
      </motion.div>
    </>
  );
};

export default DesktopNav;
