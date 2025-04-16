"use client";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  DialogTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@cap/ui";
import { classNames } from "@cap/utils";
import { Building, Check, ChevronDown, Plus, Share2 } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";

import { useSharedContext } from "@/app/dashboard/_components/DynamicSharedLayout";
import { NewSpace } from "@/components/forms/NewSpace";
import { Tooltip } from "@/components/Tooltip";
import { UsageButton } from "@/components/UsageButton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@cap/ui";
import clsx from "clsx";
import { updateActiveSpace } from "./server";

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

export const AdminNavItems = ({ collapsed }: { collapsed?: boolean }) => {
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
    ...(user.email.endsWith("@cap.so")
      ? [
          {
            name: "Admin",
            href: "/dashboard/admin",
            icon: Building, // Using Building icon as a fallback
            subNav: [],
          },
        ]
      : []),
  ];

  const navItemClass =
    "flex items-center justify-start py-2 px-3 rounded-2xl outline-none tracking-tight w-full overflow-hidden";

  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
      <div className="px-3 py-2.5 w-full rounded-2xl border border-gray-200">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <div
              className="flex justify-between items-center cursor-pointer"
              role="combobox"
              aria-expanded={open}
            >
              <div className="flex items-center w-full text-left">
                <div>
                  <p className="text-sm font-medium">
                    {activeSpace?.space.name ?? "No space found"}
                  </p>
                </div>
              </div>
              <div>
                <ChevronDown className="w-[20px] h-auto text-gray-400" />
              </div>
            </div>
          </PopoverTrigger>
          <PopoverContent className="z-10 p-0 mt-2 w-[calc(100%-10%)] mx-auto bg-white">
            <Command>
              <CommandInput placeholder="Search spaces..." />
              <CommandEmpty>No spaces found</CommandEmpty>
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
                  <CommandItem className="bg-gray-100 rounded-lg border border-gray-200 aria-selected:bg-gray-200">
                    <Plus className="mr-1 w-4 h-auto" />
                    <span className="text-sm">Add new space</span>
                  </CommandItem>
                </DialogTrigger>
              </CommandGroup>
            </Command>
          </PopoverContent>
        </Popover>
      </div>
      <nav
        className="flex flex-col justify-between w-full h-full"
        aria-label="Sidebar"
      >
        <div
          className={clsx("mt-8 space-y-2.5", collapsed ? "items-center" : "")}
        >
          {manageNavigation.map((item) => (
            <div key={item.name}>
              <div className="flex justify-center">
                <Tooltip content={item.name} disable={collapsed === false}>
                  <Link
                    passHref
                    prefetch={false}
                    href={item.href}
                    className={classNames(
                      pathname.includes(item.href)
                        ? "bg-white text-gray-400 border-[1px] border-gray-200 shadow-[0_1.5px_3px_0px] shadow-gray-200"
                        : "hover:opacity-75",
                      navItemClass
                    )}
                  >
                    <item.icon
                      className={classNames(
                        "flex-shrink-0 w-5 h-5 stroke-[1.5px]"
                      )}
                      aria-hidden="true"
                    />
                    <span className="text-base ml-2.5 text-gray-400 truncate">
                      {item.name}
                    </span>
                  </Link>
                </Tooltip>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-auto">
          <div className="pb-5 mb-3 w-full">
            <UsageButton
              collapsed={collapsed ?? false}
              subscribed={isSubscribed}
            />
          </div>
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
