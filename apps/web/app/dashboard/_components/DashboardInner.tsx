"use client";

import {
  Command,
  CommandGroup,
  CommandItem,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@cap/ui";
import { LogOut, MessageSquare, MoreVertical, Settings } from "lucide-react";
import { useState } from "react";

import { useSharedContext } from "@/app/dashboard/_components/DynamicSharedLayout";
import { Avatar } from "@/app/s/[videoId]/_components/tabs/Activity";
import clsx from "clsx";
import { signOut } from "next-auth/react";
import Link from "next/link";

export default function DashboardInner({
  children,
  title,
  emptyCondition,
  emptyComponent,
}: {
  children: React.ReactNode;
  title?: string;
  emptyCondition?: boolean;
  emptyComponent?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col pt-5 min-h-screen lg:gap-5">
      {/* Top Bar */}
      <div
        className={clsx(
          "flex sticky z-10 justify-between items-center px-5 mt-10 w-full h-16 bg-gray-50 border-b border-gray-200 lg:border-b-0 lg:pl-0 lg:pr-5 lg:top-0 lg:relative top-[64px] lg:mt-0 lg:h-8"
        )}
      >
        <p className="relative text-xl text-gray-500 lg:text-2xl">{title}</p>
        <User />
      </div>
      {/* Content Area */}
      <div
        className={clsx(
          "flex overflow-auto flex-col flex-1 p-5 pb-5 bg-gray-100 border border-gray-200 lg:rounded-tl-2xl lg:p-8"
        )}
      >
        {emptyCondition ? (
          emptyComponent
        ) : (
          <div className="flex flex-col gap-4">{children}</div>
        )}
      </div>
    </div>
  );
}

const User = () => {
  const [menuOpen, setMenuOpen] = useState(false);
  const { user } = useSharedContext();
  return (
    <Popover open={menuOpen} onOpenChange={setMenuOpen}>
      <PopoverTrigger asChild>
        <div className="flex gap-2 justify-between items-center p-2 rounded-lg transition-colors cursor-pointer lg:gap-6 hover:bg-gray-100">
          <div className="flex items-center">
            <Avatar
              letterClass="text-xs lg:text-md"
              name={user.name ?? "User"}
              className="size-[24px]"
            />
            <span className="ml-2 text-sm lg:ml-3 lg:text-md">
              {user.name ?? "User"}
            </span>
          </div>
          <MoreVertical className="w-5 h-5 text-gray-400 group-hover:text-gray-500" />
        </div>
      </PopoverTrigger>
      <PopoverContent className="p-1 w-48 bg-gray-50">
        <Command>
          <CommandGroup>
            <Link href="/dashboard/settings">
              <CommandItem
                className="px-2 py-2 rounded-lg transition-colors duration-300 cursor-pointer hover:bg-gray-100 group"
                onSelect={() => {
                  setMenuOpen(false);
                }}
              >
                <Settings className="mr-2 w-4 h-4 text-gray-400 group-hover:text-gray-500" />
                <span className="text-sm text-gray-400 group-hover:text-gray-500">
                  Settings
                </span>
              </CommandItem>
            </Link>
            <CommandItem
              className="px-2 py-2 rounded-lg transition-colors duration-300 cursor-pointer hover:bg-gray-100 group"
              onSelect={() => window.open("https://cap.link/discord", "_blank")}
            >
              <MessageSquare className="mr-2 w-4 h-4 text-gray-400 group-hover:text-gray-500" />
              <span className="text-sm text-gray-400 group-hover:text-gray-500">
                Chat Support
              </span>
            </CommandItem>
            <CommandItem
              className="px-2 py-2 rounded-lg transition-colors duration-300 cursor-pointer hover:bg-gray-100 group"
              onSelect={() => signOut()}
            >
              <LogOut className="mr-2 w-4 h-4 text-gray-400 group-hover:text-gray-500" />
              <span className="text-sm text-gray-400 group-hover:text-gray-500">
                Sign Out
              </span>
            </CommandItem>
          </CommandGroup>
        </Command>
      </PopoverContent>
    </Popover>
  );
};
