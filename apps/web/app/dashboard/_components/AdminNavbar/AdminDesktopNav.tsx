"use client";
import { Logo } from "@cap/ui";
import Link from "next/link";
import { AdminNavItems } from "./AdminNavItems";

export const AdminDesktopNav = () => {
  return (
    <>
      <div className="hidden h-full lg:flex lg:flex-shrink-0 group">
        <div className="flex flex-col w-[200px]">
          <div className="flex overflow-y-auto flex-col flex-grow h-full">
            <div className="flex flex-col flex-shrink-0 items-start px-4 h-full justify-top">
              <div className="flex justify-center w-full h-[10vh] items-center">
                <Link href="/dashboard">
                  <Logo className="w-auto h-9" />
                </Link>
              </div>
              <AdminNavItems />
            </div>
          </div>
        </div>
      </div>
    </>
  );
};

export default AdminDesktopNav;
