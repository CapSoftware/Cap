"use client";

import {
  Command,
  CommandGroup,
  CommandItem,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@cap/ui";
import { MoreVertical } from "lucide-react";
import { useState } from "react";

import { useSharedContext } from "@/app/dashboard/_components/DynamicSharedLayout";
import { Avatar } from "@/app/s/[videoId]/_components/tabs/Activity";
import {
  faGear,
  faHome,
  faMessage,
  faSignOut,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import clsx from "clsx";
import { signOut } from "next-auth/react";
import Link from "next/link";
import { usePathname } from "next/navigation";

export default function DashboardInner({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const titles: Record<string, string> = {
    "/dashboard/caps": "Caps",
    "/dashboard/shared-caps": "Shared Caps",
    "/dashboard/settings/workspace": "Workspace Settings",
    "/dashboard/settings/account": "Account Settings",
  };
  const title = titles[pathname] || "";
  return (
    <div className="flex flex-col pt-5 min-h-screen lg:gap-5">
      {/* Top Bar */}
      <div
        className={clsx(
          "flex sticky z-50 justify-between items-center px-5 mt-10 w-full h-16 bg-gray-50 border-b border-gray-200 lg:border-b-0 lg:pl-0 lg:pr-5 lg:top-0 lg:relative top-[64px] lg:mt-0 lg:h-8"
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
        <div className="flex flex-col gap-4">{children}</div>
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
            <Link href="/home">
              <CommandItem
                className="px-2 py-1.5 rounded-lg transition-colors duration-300 cursor-pointer hover:bg-gray-100 group"
                onSelect={() => {
                  setMenuOpen(false);
                }}
              >
                <FontAwesomeIcon
                  icon={faHome}
                  className="mr-2 text-gray-400 transition-colors duration-300 size-3.5 group-hover:text-gray-500"
                />
                <span className="text-[13px] transition-colors duration-300 text-gray-400 group-hover:text-gray-500">
                  Homepage
                </span>
              </CommandItem>
            </Link>
            <Link href="/dashboard/settings/account">
              <CommandItem
                className="px-2 py-1.5 rounded-lg transition-colors duration-300 cursor-pointer hover:bg-gray-100 group"
                onSelect={() => {
                  setMenuOpen(false);
                }}
              >
                <FontAwesomeIcon
                  icon={faGear}
                  className="mr-2 text-gray-400 transition-colors duration-300 size-3.5 group-hover:text-gray-500"
                />
                <span className="text-[13px] transition-colors duration-300 text-gray-400 group-hover:text-gray-500">
                  Settings
                </span>
              </CommandItem>
            </Link>
            <CommandItem
              className="px-2 py-1.5 rounded-lg transition-colors duration-300 cursor-pointer hover:bg-gray-100 group"
              onSelect={() => window.open("https://cap.link/discord", "_blank")}
            >
              <FontAwesomeIcon
                icon={faMessage}
                className="mr-2 text-gray-400 transition-colors duration-300 size-3 group-hover:text-gray-500"
              />
              <span className="text-[13px] transition-colors duration-300 text-gray-400 group-hover:text-gray-500">
                Chat Support
              </span>
            </CommandItem>
            <CommandItem
              className="px-2 py-1.5 rounded-lg transition-colors duration-300 cursor-pointer hover:bg-gray-100 group"
              onSelect={() => signOut()}
            >
              <FontAwesomeIcon
                icon={faSignOut}
                className="mr-2 text-gray-400 transition-colors duration-300 size-3.5 group-hover:text-gray-500"
              />
              <span className="text-[13px] transition-colors duration-300 text-gray-400 group-hover:text-gray-500">
                Sign Out
              </span>
            </CommandItem>
          </CommandGroup>
        </Command>
      </PopoverContent>
    </Popover>
  );
};
