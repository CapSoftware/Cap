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
import { signOut } from "next-auth/react";
import Link from "next/link";

export default function DashboardInner({
  children,
  title,
  emptyCondition,
  emptyComponent,
}: {
  children: React.ReactNode;
  title: string;
  emptyCondition?: boolean;
  emptyComponent?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-5 pt-5 min-h-screen">
      {/* Top Bar */}
      <div className="h-[8vh] lg:h-[5vh] border-b lg:border-0 border-gray-200 w-full mt-4 lg:mt-0 fixed top-12 lg:top-0 bg-gray-50 z-10 lg:relative flex items-center justify-between px-5 lg:pr-8 lg:pl-0">
        <p className="text-xl text-gray-500">{title}</p>
        <User />
      </div>
      {/* Content Area */}
      <div className="flex overflow-auto flex-col flex-1 p-5 pb-5 bg-gray-100 border border-gray-200 mt-[120px] lg:mt-0 lg:rounded-tl-2xl lg:p-8">
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
              className="size-[24px] lg:size-[36px]"
            />
            <span className="ml-2 text-sm lg:ml-3 lg:text-md">
              {user.name ?? "User"}
            </span>
          </div>
          <MoreVertical className="w-5 h-5 text-gray-400 group-hover:text-gray-500" />
        </div>
      </PopoverTrigger>
      <PopoverContent className="p-1 w-48 bg-gray-100">
        <Command>
          <CommandGroup>
            <Link href="/dashboard/settings">
              <CommandItem
                className="px-2 py-2 rounded-lg cursor-pointer hover:bg-gray-200 group"
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
              className="px-2 py-2 rounded-lg cursor-pointer hover:bg-gray-200 group"
              onSelect={() => window.open("https://cap.link/discord", "_blank")}
            >
              <MessageSquare className="mr-2 w-4 h-4 text-gray-400 group-hover:text-gray-500" />
              <span className="text-sm text-gray-400 group-hover:text-gray-500">
                Chat Support
              </span>
            </CommandItem>
            <CommandItem
              className="px-2 py-2 rounded-lg cursor-pointer hover:bg-gray-200 group"
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
