"use client";
import { usePathname, useRouter } from "next/navigation";
import {
  Plus,
  LogOut,
  ChevronDown,
  User,
  MoreVertical,
  Settings,
  MessageSquare,
  Share2,
  Check,
  Building,
} from "lucide-react";
import Link from "next/link";
import { classNames } from "@cap/utils";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  DialogTrigger,
} from "@cap/ui";
import { Popover, PopoverContent, PopoverTrigger } from "@cap/ui";
import { useState } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@cap/ui";
import { NewSpace } from "@/components/forms/NewSpace";
import { signOut } from "next-auth/react";
import { useSharedContext } from "@/app/dashboard/_components/DynamicSharedLayout";
import { UsageButton } from "@/components/UsageButton";
import { updateActiveSpace } from "./server";
import { Avatar } from "@/app/s/[videoId]/_components/tabs/Activity";

const Clapperboard = ({ className }: { className: string }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    fill="none"
    viewBox="0 0 18 15"
    className={className}
  >
    <path
      stroke="#8991A3"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.667"
      d="M1.5 5.833h15m-15 0v5a2.5 2.5 0 002.5 2.5h10a2.5 2.5 0 002.5-2.5v-5m-15 0V4.167a2.5 2.5 0 012.5-2.5h10a2.5 2.5 0 012.5 2.5v1.666M5.583 2.083l-.666 3.334m4.416-3.334l-.666 3.334m4.416-3.334l-.666 3.334"
    ></path>
  </svg>
);

const Download = ({ className }: { className: string }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    fill="none"
    viewBox="0 0 16 15"
    className={className}
  >
    <path
      stroke="#8991A3"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.667"
      d="M14.667 10v1.667a2.5 2.5 0 01-2.5 2.5H3.833a2.5 2.5 0 01-2.5-2.5V10M8 9.583V.833m0 8.75L5.083 6.667M8 9.583l2.917-2.916"
    ></path>
  </svg>
);

export const AdminNavItems = () => {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const { spaceData, activeSpace, user, isSubscribed } = useSharedContext();
  const [menuOpen, setMenuOpen] = useState(false);
  const router = useRouter();

  const manageNavigation = [
    {
      name: "My Caps",
      href: `/dashboard/caps`,
      icon: Clapperboard,
      subNav: [],
    },
    {
      name: "Shared Caps",
      href: `/dashboard/shared-caps`,
      icon: Share2,
      subNav: [],
    },
    {
      name: "Download App",
      href: `/download`,
      icon: Download,
      subNav: [],
    },
    {
      name: "Workspace",
      href: `/dashboard/settings/workspace`,
      icon: Building,
      subNav: [],
    },
  ];

  const navItemClass =
    "flex items-center justify-start py-2 px-3 rounded-full outline-none tracking-tight w-full";

  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
      <div className="w-full py-3 my-4 border-b-2 border-t-2 border-gray-300 border-dotted">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <div
              className="flex items-center justify-between cursor-pointer"
              role="combobox"
              aria-expanded={open}
            >
              <div className="flex items-center w-full text-left">
                <div>
                  <p className="text-[0.875rem]">
                    {activeSpace?.space.name ?? "No space found"}
                  </p>
                </div>
              </div>
              <div>
                <ChevronDown className="w-[20px] h-auto text-gray-400" />
              </div>
            </div>
          </PopoverTrigger>
          <PopoverContent className="w-full p-0 z-10 bg-white">
            <Command>
              <CommandInput placeholder="Search spaces..." />
              <CommandEmpty>No spaces found.</CommandEmpty>
              <CommandGroup>
                {spaceData?.map((space) => {
                  const isSelected = activeSpace?.space.id === space.space.id;

                  return (
                    <CommandItem
                      key={space.space.name + "-space"}
                      onSelect={async () => {
                        await updateActiveSpace(space.space.id);
                        setOpen(false);
                      }}
                    >
                      {space.space.name}
                      <Check
                        size={18}
                        className={classNames(
                          "ml-auto",
                          isSelected ? "opacity-100" : "opacity-0"
                        )}
                      />
                    </CommandItem>
                  );
                })}
                <DialogTrigger className="w-full">
                  <CommandItem className=" bg-filler aria-selected:bg-gray-200 rounded-lg">
                    <Plus className="w-4 h-auto mr-1" />
                    <span className="text-[0.875rem]">Add new space</span>
                  </CommandItem>
                </DialogTrigger>
              </CommandGroup>
            </Command>
          </PopoverContent>
        </Popover>
      </div>
      <nav
        className="w-full flex flex-col justify-between h-full"
        aria-label="Sidebar"
      >
        <div className="space-y-1">
          {manageNavigation.map((item) => (
            <div key={item.name}>
              <Link
                passHref
                prefetch={false}
                href={item.href}
                className={classNames(
                  pathname.includes(item.href)
                    ? "bg-white text-black border-[1px] border-gray-200"
                    : "opacity-50 hover:opacity-75",
                  navItemClass
                )}
              >
                <item.icon
                  className={classNames(
                    "flex-shrink-0 w-5 h-5 stroke-[1.5px]",
                    pathname.includes(item.href) ? "text-black" : ""
                  )}
                  aria-hidden="true"
                />
                <span className="text-base ml-2.5 text-black">{item.name}</span>
              </Link>
            </div>
          ))}
        </div>
        <div className="mt-auto">
          <div className="w-full mb-3 pb-5 border-b-2 border-gray-200 border-dotted">
            <UsageButton subscribed={isSubscribed} />
          </div>
          <Popover open={menuOpen} onOpenChange={setMenuOpen}>
            <PopoverTrigger asChild>
              <div className="flex items-center justify-between cursor-pointer hover:bg-gray-100 p-2 rounded-lg transition-colors">
                <div className="flex items-center">
                  <Avatar name={user.name ?? "User"} className="h-8 w-8" />
                  <span className="ml-2 text-sm">{user.name ?? "User"}</span>
                </div>
                <MoreVertical className="h-5 w-5 text-gray-500 group-hover:text-gray-500" />
              </div>
            </PopoverTrigger>
            <PopoverContent className="bg-gray-100 w-48 p-1">
              <Command>
                <CommandGroup>
                  <CommandItem
                    className="py-2 px-2 rounded-lg hover:bg-gray-200 cursor-pointer group"
                    onSelect={() => {
                      router.push("/dashboard/settings");
                      setMenuOpen(false);
                    }}
                  >
                    <Settings className="mr-2 h-4 w-4 text-gray-400 group-hover:text-gray-500" />
                    <span className="text-gray-400 group-hover:text-gray-500 text-sm">
                      Settings
                    </span>
                  </CommandItem>
                  <CommandItem
                    className="py-2 px-2 rounded-lg hover:bg-gray-200 cursor-pointer group"
                    onSelect={() =>
                      window.open("https://cap.link/discord", "_blank")
                    }
                  >
                    <MessageSquare className="mr-2 h-4 w-4 text-gray-400 group-hover:text-gray-500" />
                    <span className="text-gray-400 group-hover:text-gray-500 text-sm">
                      Chat Support
                    </span>
                  </CommandItem>
                  <CommandItem
                    className="py-2 px-2 rounded-lg hover:bg-gray-200 cursor-pointer group"
                    onSelect={() => signOut()}
                  >
                    <LogOut className="mr-2 h-4 w-4 text-gray-400 group-hover:text-gray-500" />
                    <span className="text-gray-400 group-hover:text-gray-500 text-sm">
                      Sign Out
                    </span>
                  </CommandItem>
                </CommandGroup>
              </Command>
            </PopoverContent>
          </Popover>
        </div>
      </nav>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create a new Space</DialogTitle>
        </DialogHeader>
        <DialogDescription>
          <NewSpace onSpaceCreated={() => setDialogOpen(false)} />
        </DialogDescription>
      </DialogContent>
    </Dialog>
  );
};

export default AdminNavItems;
