"use client";
import { createContext, useContext } from "react";
import AdminDesktopNav from "@/app/dashboard/_components/AdminNavbar/AdminDesktopNav";
import AdminMobileNav from "@/app/dashboard/_components/AdminNavbar/AdminMobileNav";
import type { Database } from "@/utils/database/supabase/types";

type SharedContext = {
  spaceData: Database["public"]["Tables"]["spaces"]["Row"][] | null;
  activeSpace: Database["public"]["Tables"]["spaces"]["Row"] | null;
};

const Context = createContext<SharedContext>({} as SharedContext);

export default function DynamicSharedLayout({
  children,
  spaceData,
  activeSpace,
}: {
  children: React.ReactNode;
  spaceData: SharedContext["spaceData"];
  activeSpace: SharedContext["activeSpace"];
}) {
  return (
    <Context.Provider value={{ spaceData, activeSpace }}>
      <div className="h-screen min-h-full flex">
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
