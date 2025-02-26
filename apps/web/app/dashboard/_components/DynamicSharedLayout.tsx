"use client";
import { createContext, useContext } from "react";
import AdminDesktopNav from "@/app/dashboard/_components/AdminNavbar/AdminDesktopNav";
import AdminMobileNav from "@/app/dashboard/_components/AdminNavbar/AdminMobileNav";
import { users, spaces } from "@cap/database/schema";
import { Space } from "@/app/dashboard/layout";

type SharedContext = {
  spaceData: Space[] | null;
  activeSpace: Space | null;
  user: typeof users.$inferSelect;
  isSubscribed: boolean;
  isSuperAdmin: boolean;
};

const Context = createContext<SharedContext>({} as SharedContext);

export default function DynamicSharedLayout({
  children,
  spaceData,
  activeSpace,
  user,
  isSubscribed,
  isSuperAdmin,
}: {
  children: React.ReactNode;
  spaceData: SharedContext["spaceData"];
  activeSpace: SharedContext["activeSpace"];
  user: SharedContext["user"];
  isSubscribed: SharedContext["isSubscribed"];
  isSuperAdmin: SharedContext["isSuperAdmin"];
}) {
  return (
    <Context.Provider
      value={{ spaceData, activeSpace, user, isSubscribed, isSuperAdmin }}
    >
      <div className="dashboard-layout h-screen min-h-full flex">
        <AdminDesktopNav />
        <div className="flex-1 overflow-auto focus:outline-none">
          <AdminMobileNav />
          <main className="min-h-screen w-full">{children}</main>
        </div>
      </div>
    </Context.Provider>
  );
}

export const useSharedContext = () => useContext(Context);
