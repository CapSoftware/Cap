"use client";
import { createContext, useContext } from "react";
import AdminDesktopNav from "@/app/dashboard/_components/AdminNavbar/AdminDesktopNav";
import AdminMobileNav from "@/app/dashboard/_components/AdminNavbar/AdminMobileNav";

type SharedContext = {
  spaceData: null;
  activeSpace: null;
  user: typeof users.$inferSelect | null;
};

const Context = createContext<SharedContext>({} as SharedContext);

export default function DynamicSharedLayout({
  children,
  spaceData,
  activeSpace,
  user,
}: {
  children: React.ReactNode;
  spaceData: SharedContext["spaceData"];
  activeSpace: SharedContext["activeSpace"];
  user: SharedContext["user"];
}) {
  return (
    <Context.Provider value={{ spaceData, activeSpace, user }}>
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
