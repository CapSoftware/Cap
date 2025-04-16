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
    <>
      <div className="h-[100vh] flex flex-col items-between gap-5 pt-5">
        <div className="h-[5vh] w-full justify-between flex items-center pr-8">
          <p className="text-xl text-gray-500">{title}</p>
          <User />
        </div>
        <div className="flex flex-grow h-[90vh] bg-gray-100 rounded-tl-2xl p-8 border-[1px] border-gray-200">
          {emptyCondition ? emptyComponent : children}
        </div>
      </div>
    </>
  );
}

const User = () => {
  const [menuOpen, setMenuOpen] = useState(false);
  const { user } = useSharedContext();
  return (
    <Popover open={menuOpen} onOpenChange={setMenuOpen}>
      <PopoverTrigger asChild>
        <div className="flex gap-6 justify-between items-center p-2 rounded-lg transition-colors cursor-pointer hover:bg-gray-100">
          <div className="flex items-center">
            <Avatar
              letterClass="text-md"
              name={user.name ?? "User"}
              className="size-[36px]"
            />
            <span className="ml-3 text-md">{user.name ?? "User"}</span>
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
