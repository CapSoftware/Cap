"use client";
import { Tooltip } from "@/components/Tooltip";
import { Logo } from "@cap/ui";
import clsx from "clsx";
import { motion } from "framer-motion";
import { useDetectPlatform } from "hooks/useDetectPlatform";
import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";
import { useSharedContext } from "../DynamicSharedLayout";
import { AdminNavItems } from "./AdminNavItems";

export const AdminDesktopNav = () => {
  const { toggleSidebarCollapsed, sidebarCollapsed } = useSharedContext();
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
          width: sidebarCollapsed ? "70px" : "250px",
        }}
        animate={{
          width: sidebarCollapsed ? "70px" : "250px",
          transition: {
            duration: 0.4,
            type: "spring",
            bounce: 0.25,
          },
        }}
        className={clsx("hidden z-50 h-full lg:flex group", "relative")}
      >
        <div className="flex flex-col w-full max-w-[220px] mx-auto">
          <div className="flex overflow-hidden flex-col flex-grow h-full">
            <div className="flex flex-col flex-shrink-0 items-start px-3 pt-5 w-full h-full justify-top">
              <div className="flex justify-start items-center mb-3.5 w-full truncate min-h-8">
                <Link href="/dashboard">
                  <Logo
                    className={clsx(
                      "flex-shrink-0 mx-auto w-[120px]",
                      sidebarCollapsed ? "ml-1" : "ml-0"
                    )}
                  />
                </Link>
              </div>
              <AdminNavItems />
            </div>
          </div>

          {/* Collapse toggle button - moved outside the overflow container */}
          <Tooltip
            kbd={[cmdSymbol, "Shift", "S"]}
            position="right"
            content="Toggle collapse"
          >
            <button
              onClick={toggleSidebarCollapsed}
              className="absolute right-[-12px] hover:border-gray-5 hover:bg-gray-5 top-[50%] transform -translate-y-1/2 rounded-full p-1 border bg-gray-3 border-gray-4 transition-colors z-10"
            >
              <ChevronRight size={16} className={clsx("transition-transform duration-200 text-gray-12", sidebarCollapsed ? "rotate-180" : "")} />
            </button>
          </Tooltip>
        </div>
      </motion.div>
    </>
  );
};

export default AdminDesktopNav;
