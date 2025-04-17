"use client";
import { Tooltip } from "@/components/Tooltip";
import { Logo } from "@cap/ui";
import clsx from "clsx";
import { motion } from "framer-motion";
import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { AdminNavItems } from "./AdminNavItems";

export const AdminDesktopNav = () => {
  const [collapsed, setCollapsed] = useState(
    localStorage.getItem("sidebarCollapsed") === "true"
  );
  const toggleCollapse = () => {
    setCollapsed(!collapsed);
    localStorage.setItem("sidebarCollapsed", String(!collapsed));
  };

  return (
    <>
      <motion.div
        initial={{
          width: collapsed ? "70px" : "250px",
        }}
        animate={{
          width: collapsed ? "70px" : "250px",
          transition: {
            duration: 0.4,
            type: "spring",
            bounce: 0.25
          },
        }}
        className={clsx(
          "hidden h-full lg:flex lg:flex-shrink-0 group",
          "relative"
        )}
      >
        <div className="flex flex-col w-full max-w-[220px] mx-auto">
          <div className="flex overflow-hidden flex-col flex-grow h-full">
            <div className="flex flex-col flex-shrink-0 items-start px-3 w-full h-full justify-top">
              <div className="truncate items-center flex justify-center w-full h-[10vh]">
                <Link href="/dashboard">
                  <Logo
                    className={clsx("flex-shrink-0 mx-auto w-[120px]", collapsed ? "ml-1" : "ml-0")}
                  />
                </Link>
              </div>
              <AdminNavItems collapsed={collapsed} />
            </div>
          </div>

          {/* Collapse toggle button - moved outside the overflow container */}
          <Tooltip kbd={['⌘', 'S']} position="right" content="Toggle collapse">
            <button
              onClick={toggleCollapse}
              className="absolute right-[-12px] hover:border-gray-400 top-[50%] transform -translate-y-1/2 bg-gray-50 rounded-full p-1 border border-gray-200 hover:bg-gray-50 transition-colors z-10"
            >
              {collapsed ? (
              <ChevronRight size={16} className="text-gray-500" />
            ) : (
              <ChevronLeft size={16} className="text-gray-500" />
            )}
          </button>
          </Tooltip>
        </div>
      </motion.div>
    </>
  );
};

export default AdminDesktopNav;
