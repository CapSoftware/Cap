"use client";
import AdminMobileNav from "@/app/dashboard/_components/AdminNavbar/AdminMobileNav";
import { Organization } from "@/app/dashboard/layout";
import { users } from "@cap/database/schema";
import Cookies from "js-cookie";
import React, { createContext, useContext, useEffect, useState } from "react";
import AdminDesktopNav from "./AdminNavbar/AdminDesktopNav";

type SharedContext = {
  organizationData: Organization[] | null;
  activeOrganization: Organization | null;
  user: typeof users.$inferSelect;
  isSubscribed: boolean;
};

type ITheme = "light" | "dark";

const Context = createContext<SharedContext>({} as SharedContext);

const ThemeContext = createContext<{
  theme: ITheme;
  setThemeHandler: (newTheme: ITheme) => void;
}>({
  theme: "light",
  setThemeHandler: () => {},
});

export const useTheme = () => useContext(ThemeContext);

export default function DynamicSharedLayout({
  children,
  organizationData,
  activeOrganization,
  user,
  isSubscribed,
  initialTheme,
}: {
  children: React.ReactNode;
  organizationData: SharedContext["organizationData"];
  activeOrganization: SharedContext["activeOrganization"];
  user: SharedContext["user"];
  isSubscribed: SharedContext["isSubscribed"];
  initialTheme: ITheme;
}) {
  const [theme, setTheme] = useState<ITheme>(initialTheme);
  const setThemeHandler = (newTheme: ITheme) => {
    setTheme(newTheme);
    Cookies.set("theme", newTheme, {
      expires: 365,
    });
    document.body.className = newTheme;
  };
  useEffect(() => {
    if (Cookies.get("theme")) {
      document.body.className = Cookies.get("theme") as ITheme;
    }
    return () => {
      document.body.className = "light";
    };
  }, [theme]);
  return (
    <ThemeContext.Provider value={{ theme, setThemeHandler }}>
      <Context.Provider
        value={{
          organizationData,
          activeOrganization,
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
          <div className="overflow-y-auto col-span-1 row-span-2 custom-scroll focus:outline-none">
            <AdminMobileNav />
            {children}
          </div>
        </div>
      </Context.Provider>
    </ThemeContext.Provider>
  );
}

export const useSharedContext = () => useContext(Context);
