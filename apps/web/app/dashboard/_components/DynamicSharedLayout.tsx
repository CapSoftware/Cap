"use client";
import AdminMobileNav from "@/app/dashboard/_components/AdminNavbar/AdminMobileNav";
import { Organization } from "@/app/dashboard/layout";
import { UpgradeModal } from "@/components/UpgradeModal";
import { users } from "@cap/database/schema";
import Cookies from "js-cookie";
import { createContext, useContext, useEffect, useState } from "react";
import AdminDesktopNav from "./AdminNavbar/AdminDesktopNav";

type SharedContext = {
  organizationData: Organization[] | null;
  activeOrganization: Organization | null;
  user: typeof users.$inferSelect;
  isSubscribed: boolean;
  toggleSidebarCollapsed: () => void;
  sidebarCollapsed: boolean;
  upgradeModalOpen: boolean;
  setUpgradeModalOpen: (open: boolean) => void;
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
  initialSidebarCollapsed,
}: {
  children: React.ReactNode;
  organizationData: SharedContext["organizationData"];
  activeOrganization: SharedContext["activeOrganization"];
  user: SharedContext["user"];
  isSubscribed: SharedContext["isSubscribed"];
  initialTheme: ITheme;
  initialSidebarCollapsed: boolean;
}) {
  const [theme, setTheme] = useState<ITheme>(initialTheme);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    initialSidebarCollapsed
  );
  const [upgradeModalOpen, setUpgradeModalOpen] = useState(false);
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
    if (Cookies.get("sidebarCollapsed")) {
      setSidebarCollapsed(Cookies.get("sidebarCollapsed") === "true");
    }
    return () => {
      document.body.className = "light";
    };
  }, [theme]);
  const toggleSidebarCollapsed = () => {
    setSidebarCollapsed(!sidebarCollapsed);
    Cookies.set("sidebarCollapsed", !sidebarCollapsed ? "true" : "false", {
      expires: 365,
    });
  };

  return (
    <ThemeContext.Provider value={{ theme, setThemeHandler }}>
      <Context.Provider
        value={{
          organizationData,
          activeOrganization,
          user,
          isSubscribed,
          toggleSidebarCollapsed,
          sidebarCollapsed,
          upgradeModalOpen,
          setUpgradeModalOpen,
        }}
      >
        {/* CSS Grid layout for dashboard */}
        <div className="grid grid-cols-[auto,1fr] overflow-y-auto bg-gray-1 grid-rows-[auto,1fr] h-dvh min-h-dvh">
          {/* Sidebar */}
          <aside className="z-10 col-span-1 row-span-2">
            <AdminDesktopNav />
          </aside>
          {/* Header/topbar is now expected to be rendered by children if needed */}
          {/* Main content area */}
          <div className="flex col-span-1 row-span-2 h-full custom-scroll focus:outline-none">
            <AdminMobileNav />
            {children}
          </div>

          {/* Global upgrade modal that persists regardless of navigation state */}
          <UpgradeModal
            open={upgradeModalOpen}
            onOpenChange={setUpgradeModalOpen}
          />
        </div>
      </Context.Provider>
    </ThemeContext.Provider>
  );
}

export const useSharedContext = () => useContext(Context);
