"use client";
import { Logo } from "ui";
import Link from "next/link";
import { AdminNavItems } from "./AdminNavItems";

export const AdminDesktopNav = () => {
  return (
    <>
      <div className="hidden lg:flex lg:flex-shrink-0 bg-gray-50 group">
        <div className="flex flex-col w-64">
          <div className="flex flex-col flex-grow pt-8 pb-4 overflow-y-auto h-full">
            <div className="flex flex-col justify-top items-start flex-shrink-0 px-4 h-full">
              <div className="flex justify-start w-full">
                <Link href="/dashboard">
                  <Logo className="h-9 w-full" />
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
