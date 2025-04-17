"use client";
import { LogoBadge } from "@cap/ui";
import { useClickAway } from "@uidotdev/usehooks";
import { AnimatePresence, motion } from "framer-motion";
import { Menu, X } from "lucide-react";
import Link from "next/link";
import { MutableRefObject, useState } from "react";
import { AdminNavItems } from "./AdminNavItems";

export const AdminMobileNav = () => {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const sidebarRef: MutableRefObject<HTMLDivElement> = useClickAway(() =>
    setSidebarOpen(false)
  );
  return (
    <>
      <AnimatePresence mode="wait">
        {sidebarOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="flex fixed inset-0 z-50 lg:hidden bg-gray-200/50"
          >
            <motion.div
              ref={sidebarRef}
              initial={{ x: "100%" }}
              animate={{
                x: 0,
                transition: { duration: 0.3, bounce: 0.2, type: "spring" },
              }}
              exit={{ x: "100%" }}
              className="relative flex-1 flex flex-col ml-auto max-w-xs w-[275px] pt-5 pb-4 px-4 bg-gray-50"
            >
              <div
                className="flex justify-end items-center mb-6 w-full rounded-full"
                onClick={() => setSidebarOpen(false)}
              >
                <X className="text-gray-500 size-7" aria-hidden="true" />
              </div>

              <AdminNavItems />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      <div className="flex fixed z-10 justify-between w-full h-16 bg-gray-50 border-b lg:border-none lg:hidden">
        <div className="flex flex-shrink-0 items-center px-4 h-full lg:hidden">
          <Link className="block" href="/dashboard">
            <LogoBadge className="block w-auto h-8" />
          </Link>
        </div>
        <button
          className="flex flex-col gap-2 justify-center items-center px-5 text-white border-l lg:hidden"
          onClick={() => setSidebarOpen(true)}
        >
          <Menu className="text-gray-500 size-7" aria-hidden="true" />
        </button>
      </div>
    </>
  );
};

export default AdminMobileNav;
