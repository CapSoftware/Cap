"use client";
import { Logo } from "@cap/ui";
import clsx from "clsx";
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
      <div
        className={clsx(
          "hidden h-full transition-all duration-300 lg:flex lg:flex-shrink-0 group",
          collapsed ? "w-[70px]" : "w-[250px]",
          "relative"
        )}
      >
        <div className="flex flex-col w-full max-w-[220px] mx-auto">
          <div className="flex overflow-hidden flex-col flex-grow h-full">
            <div className="flex flex-col flex-shrink-0 items-start px-3 w-full h-full justify-top">
              <div className="flex justify-center w-full h-[10vh] items-center">
                <Link href="/dashboard">
                  <Logo
                    hideLogoName={collapsed}
                    className={collapsed ? "w-8" : "w-24"}
                  />
                </Link>
              </div>
              <AdminNavItems collapsed={collapsed} />
            </div>
          </div>

          {/* Collapse toggle button - moved outside the overflow container */}
          <button
            onClick={toggleCollapse}
            className="absolute right-[-12px] hover:border-gray-500 top-[50%] transform -translate-y-1/2 bg-white rounded-full p-1 border border-gray-200 hover:bg-gray-50 transition-colors z-10"
          >
            {collapsed ? (
              <ChevronRight size={16} className="text-gray-500" />
            ) : (
              <ChevronLeft size={16} className="text-gray-500" />
            )}
          </button>
        </div>
      </div>
    </>
  );
};

export default AdminDesktopNav;
