"use client";
import AdminMobileNav from "@/app/dashboard/_components/AdminNavbar/AdminMobileNav";
import { Space } from "@/app/dashboard/layout";
import { users } from "@cap/database/schema";
import React, { createContext, useContext } from "react";
import AdminDesktopNav from "./AdminNavbar/AdminDesktopNav";

type SharedContext = {
  spaceData: Space[] | null;
  activeSpace: Space | null;
  user: typeof users.$inferSelect;
  isSubscribed: boolean;
};

const Context = createContext<SharedContext>({} as SharedContext);

export default function DynamicSharedLayout({
  children,
  spaceData,
  activeSpace,
  user,
  isSubscribed,
}: {
  children: React.ReactNode;
  spaceData: SharedContext["spaceData"];
  activeSpace: SharedContext["activeSpace"];
  user: SharedContext["user"];
  isSubscribed: SharedContext["isSubscribed"];
}) {
  return (
    <Context.Provider
      value={{
        spaceData,
        activeSpace,
        user,
        isSubscribed,
      }}
    >
      {/* CSS Grid layout for dashboard */}
      <div className="grid grid-cols-[auto,1fr] bg-gray-2 grid-rows-[auto,1fr] h-screen min-h-screen">
        {/* Sidebar */}
        <aside className="z-10 col-span-1 row-span-2">
          <AdminDesktopNav />
        </aside>
        {/* Header/topbar is now expected to be rendered by children if needed */}
        {/* Main content area */}
        <div className="overflow-y-auto col-span-1 row-span-2 focus:outline-none">
          <AdminMobileNav />
          {children}
        </div>
      </div>
    </Context.Provider>
  );
}

export const useSharedContext = () => useContext(Context);
