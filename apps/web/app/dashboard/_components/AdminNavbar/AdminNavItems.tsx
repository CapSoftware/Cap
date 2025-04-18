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
import { Check, ChevronDown, Plus } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

import { useSharedContext } from "@/app/dashboard/_components/DynamicSharedLayout";
import { Avatar } from "@/app/s/[videoId]/_components/tabs/Activity";
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
import {
  faBuilding,
  faDownload,
  faRecordVinyl,
  faShareNodes,
  IconDefinition,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import clsx from "clsx";
import { updateActiveSpace } from "./server";

export const AdminNavItems = ({ collapsed }: { collapsed?: boolean }) => {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const { spaceData, activeSpace, user, isSubscribed } = useSharedContext();

  const manageNavigation = [
    {
      name: "My Caps",
      href: `/dashboard/caps`,
      icon: faRecordVinyl,
      subNav: [],
    },
    {
      name: "Shared Caps",
      href: `/dashboard/shared-caps`,
      icon: faShareNodes,
      subNav: [],
    },
    {
      name: "Download App",
      href: `/download`,
      icon: faDownload,
      subNav: [],
    },
    {
      name: "Workspace",
      href: `/dashboard/settings/workspace`,
      icon: faBuilding,
      subNav: [],
    },
    ...(user.email.endsWith("@cap.so")
      ? [
          {
            name: "Admin",
            href: "/dashboard/admin",
            icon: faBuilding, // Using Building icon as a fallback
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
      <Tooltip
        disable={collapsed === false}
        position="right"
        content={activeSpace?.space.name ?? "No space found"}
      >
        <div className="p-3 w-full rounded-xl border border-gray-200">
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <div
                className="flex justify-between items-center cursor-pointer"
                role="combobox"
                aria-expanded={open}
              >
                <div className="flex justify-between items-center w-full text-left">
                  <div className="flex items-center">
                    <Avatar
                      className="flex-shrink-0 size-5"
                      name={activeSpace?.space.name ?? "No space found"}
                    />
                    <p className="ml-2.5 text-sm font-medium truncate">
                      {activeSpace?.space.name ?? "No space found"}
                    </p>
                  </div>
                  {!collapsed && (
                    <ChevronDown className="w-[20px] h-auto text-gray-400" />
                  )}
                </div>
              </div>
            </PopoverTrigger>
            <PopoverContent className="z-[60] p-0 mt-3 w-[calc(100%-12px)] mx-auto bg-white">
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
      </Tooltip>
      <nav
        className="flex flex-col justify-between w-full h-full"
        aria-label="Sidebar"
      >
        <div
          className={clsx("mt-8 space-y-2.5", collapsed ? "items-center" : "")}
        >
          {manageNavigation.map((item) => (
            <div key={item.name} className="flex justify-center">
              <Tooltip
                content={item.name}
                disable={collapsed === false}
                position="right"
              >
                <Link
                  passHref
                  prefetch={false}
                  href={item.href}
                  className={classNames(
                    pathname.includes(item.href)
                      ? "bg-white text-gray-400 border-[1px] border-gray-200 shadow-sm shadow-gray-200"
                      : "hover:opacity-75",
                    navItemClass
                  )}
                >
                  <FontAwesomeIcon
                    icon={item.icon as IconDefinition}
                    className={classNames(
                      "flex-shrink-0 w-5 h-5 stroke-[1.5px] text-gray-400"
                    )}
                    aria-hidden="true"
                  />
                  <span className="text-base ml-2.5 text-gray-400 truncate">
                    {item.name}
                  </span>
                </Link>
              </Tooltip>
            </div>
          ))}
        </div>
        <div className="pb-0 w-full lg:pb-5">
          <UsageButton
            collapsed={collapsed ?? false}
            subscribed={isSubscribed}
          />
          <p className="mt-4 text-xs text-center text-gray-400 truncate">
            © Cap Software, Inc. {new Date().getFullYear()}.
          </p>
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
