"use client";

import { LogoBadge } from "@cap/ui";
import { faMoon, faSun } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useClickAway } from "@uidotdev/usehooks";
import { AnimatePresence, motion } from "framer-motion";
import { Menu, X } from "lucide-react";
import Link from "next/link";
import { MutableRefObject, useState } from "react";

import NavItems from "./Items";
import { useTheme } from "../../Contexts";

export const AdminMobileNav = () => {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const sidebarRef: MutableRefObject<HTMLDivElement> = useClickAway(() =>
    setSidebarOpen(false)
  );
  const { theme, setThemeHandler } = useTheme();
  return (
    <>
      <AnimatePresence>
        {sidebarOpen ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, display: "none" }}
            className="flex fixed inset-0 z-[60] lg:hidden bg-gray-1/50"
          >
            <motion.div
              ref={sidebarRef}
              initial={{ x: "100%" }}
              animate={{
                x: 0,
                transition: { duration: 0.3, bounce: 0.2, type: "spring" },
              }}
              exit={{ x: "100%" }}
              className="relative flex-1 flex flex-col ml-auto max-w-xs w-[275px] border-l border-gray-3 pt-5 pb-4 px-4 bg-gray-2"
            >
              <div
                className="flex justify-end items-center mb-6 w-full rounded-full"
                onClick={() => setSidebarOpen(false)}
              >
                <X className="text-gray-12 size-7" aria-hidden="true" />
              </div>
              <NavItems toggleMobileNav={() => setSidebarOpen(false)} />
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>
      <div className="flex fixed z-[51] justify-between w-full h-16 border-b border-gray-3 bg-gray-1 lg:border-none lg:hidden">
        <div className="flex flex-shrink-0 items-center px-4 h-full lg:hidden">
          <Link className="block" href="/dashboard">
            <LogoBadge className="block w-auto h-8" />
          </Link>
        </div>
        <div className="flex gap-4 items-center h-full">
          <div
            onClick={() => {
              setThemeHandler(theme === "light" ? "dark" : "light");
            }}
            className="flex justify-center items-center rounded-full border transition-colors cursor-pointer lg:hidden bg-gray-4 hover:border-gray-6 hover:bg-gray-5 size-9 border-gray-5"
          >
            <FontAwesomeIcon
              className="text-gray-12 size-3.5"
              icon={theme === "dark" ? faSun : faMoon}
            />
          </div>
          <button
            className="flex flex-col gap-2 justify-center items-center px-5 h-full text-white border-l border-gray-3 lg:hidden"
            onClick={() => setSidebarOpen(true)}
          >
            <Menu className="text-gray-12 size-7" aria-hidden="true" />
          </button>
        </div>
      </div>
    </>
  );
};

export default AdminMobileNav;
