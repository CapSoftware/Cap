"use client";
import { createContext, useContext, useState } from "react";
import AdminDesktopNav from "@/app/dashboard/_components/AdminNavbar/AdminDesktopNav";
import AdminMobileNav from "@/app/dashboard/_components/AdminNavbar/AdminMobileNav";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Button,
} from "@cap/ui";
import { UsageButton } from "@/components/UsageButton";
import { users, spaces } from "@cap/database/schema";
import Link from "next/link";
import { isUserOnProPlan } from "@cap/utils";

type SharedContext = {
  spaceData: (typeof spaces.$inferSelect)[] | null;
  activeSpace: typeof spaces.$inferSelect | null;
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
          <div className="py-3 -mb-3 flex items-center justify-end wrapper space-x-3">
            <div>
              <UsageButton />
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger
                asChild
                className="flex items-center justify-center cursor-pointer w-9 h-9 bg-white hover:bg-gray-100 rounded-xl"
              >
                <button>
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="24"
                    height="24"
                    fill="none"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    className="w-7 h-7"
                    viewBox="0 0 24 24"
                  >
                    <circle cx="12" cy="12" r="1"></circle>
                    <circle cx="19" cy="12" r="1"></circle>
                    <circle cx="5" cy="12" r="1"></circle>
                  </svg>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="w-56">
                <DropdownMenuItem>
                  <div>
                    {isUserOnProPlan({
                      subscriptionStatus:
                        user?.stripeSubscriptionStatus as string,
                    }) ? (
                      <Link
                        className="w-full text-primary font-medium"
                        href="/dashboard/settings/billing"
                      >
                        Cap Pro
                      </Link>
                    ) : (
                      <Link
                        className="w-full text-primary font-medium"
                        href="/pricing"
                      >
                        Upgrade to Cap Pro
                      </Link>
                    )}
                  </div>
                </DropdownMenuItem>
                <DropdownMenuItem>
                  <Link className="w-full" href="/dashboard/settings">
                    Settings
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem>
                  <Link
                    className="w-full"
                    href="https://discord.gg/y8gdQ3WRN3"
                    target="_blank"
                  >
                    Chat support
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem>
                  <Link className="w-full" href="/download">
                    Download Mac App
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem>
                  <Link className="w-full" href="/record">
                    Record a Video
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem>
                  <Link className="w-full" href="/logout">
                    Sign out
                  </Link>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <main className="min-h-screen w-full">{children}</main>
        </div>
      </div>
    </Context.Provider>
  );
}

export const useSharedContext = () => useContext(Context);
