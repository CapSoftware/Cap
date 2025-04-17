"use client";
import AdminMobileNav from "@/app/dashboard/_components/AdminNavbar/AdminMobileNav";
import { Space } from "@/app/dashboard/layout";
import { users } from "@cap/database/schema";
import { createContext, useContext } from "react";
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
    <Context.Provider value={{ spaceData, activeSpace, user, isSubscribed }}>
      <div className="flex h-screen min-h-full dashboard-layout">
        <AdminDesktopNav />
        <div className="flex-1 focus:outline-none">
          <AdminMobileNav />
          <main className="w-full min-h-screen">{children}</main>
        </div>
      </div>
    </Context.Provider>
  );
}

export const useSharedContext = () => useContext(Context);
