"use client";
import {
  Button,
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
import { Check, ChevronDown, Plus, Search } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
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
  IconDefinition,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import clsx from "clsx";
import { motion } from "framer-motion";
import { updateActiveSpace } from "./server";

export const AdminNavItems = ({ collapsed }: { collapsed?: boolean }) => {
  const pathname = usePathname();
  const router = useRouter();
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
      name: "Settings",
      href: `/dashboard/settings/workspace`,
      icon: faBuilding,
      subNav: [],
    },
  ];

  const navItemClass = `flex items-center justify-start p-2 rounded-2xl outline-none tracking-tight w-full overflow-hidden ${
    collapsed ? "w-9" : "w-full"
  }`;

  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
      <nav
        className="flex flex-col justify-between w-full h-full"
        aria-label="Sidebar"
      >
        <div className={clsx("space-y-2.5", collapsed ? "items-center" : "")}>
          {manageNavigation.map((item) => (
            <div key={item.name} className="flex relative justify-center">
              {pathname.includes(item.href) ? (
                <motion.div
                  initial={{
                    width: collapsed ? 40 : "100%",
                    height: collapsed ? 40 : "100%",
                  }}
                  animate={{
                    width: collapsed ? 40 : "100%",
                    height: collapsed ? 40 : "100%",
                  }}
                  transition={{
                    type: "spring",
                    bounce: 0.2,
                    duration: 0.4,
                    width: { type: "tween", duration: 0.05 },
                  }}
                  layoutId="underline"
                  id="underline"
                  className={clsx(
                    "absolute inset-0 mx-auto rounded-xl shadow-sm border-gray-5 text-gray-8 border-[1px] shadow-gray-2"
                  )}
                />
              ) : null}
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
                    "relative transition-opacity duration-200 hover:opacity-75 z-3",
                    navItemClass
                  )}
                >
                  <FontAwesomeIcon
                    icon={item.icon as IconDefinition}
                    className={classNames(
                      "flex-shrink-0 w-5 h-5 transition-colors duration-200 stroke-[1.5px]",
                      collapsed ? "text-gray-12" : "text-gray-10"
                    )}
                    aria-hidden="true"
                  />
                  <span className="text-base ml-2.5 text-gray-12 truncate">
                    {item.name}
                  </span>
                </Link>
              </Tooltip>
            </div>
          ))}
          <div className="pt-1">
            <div
              className={clsx(
                "border-gray-4",
                !collapsed && "px-2 pt-4 border-t"
              )}
            >
              <div
                className={clsx(
                  "flex items-center",
                  collapsed ? "justify-center" : "justify-between mb-2"
                )}
              >
                {!collapsed && (
                  <h3 className="text-sm font-semibold text-gray-11">Spaces</h3>
                )}
                <Tooltip
                  content="Create Space"
                  disable={!collapsed}
                  position="right"
                >
                  <DialogTrigger asChild>
                    <button
                      className={clsx(
                        "rounded-lg hover:bg-gray-4",
                        collapsed ? "p-2" : "p-1"
                      )}
                    >
                      <Plus className="size-4 text-gray-11" />
                    </button>
                  </DialogTrigger>
                </Tooltip>
              </div>
              <Tooltip
                content="View Spaces"
                disable={!collapsed}
                position="right"
              >
                <Link
                  href="/dashboard/spaces"
                  className={clsx(
                    "flex items-center gap-2 rounded-lg text-gray-12 text-sm font-medium hover:bg-gray-4",
                    collapsed ? "p-2 justify-center" : "p-2 mb-2"
                  )}
                >
                  <Search className="size-4 text-gray-11" />
                  {!collapsed && <span className="text-sm">View Spaces</span>}
                </Link>
              </Tooltip>
              <div
                className={clsx(
                  "space-y-2",
                  collapsed && "flex flex-col items-center"
                )}
              >
                {spaceData?.slice(0, 3).map((space) => (
                  <Tooltip
                    key={space.space.id}
                    content={space.space.name}
                    disable={!collapsed}
                    position="right"
                  >
                    <div
                      className={clsx(
                        "flex items-center cursor-pointer rounded-lg",
                        collapsed ? "p-2 justify-center" : "gap-2 py-1.5 px-2",
                        activeSpace?.space.id === space.space.id
                          ? "bg-gray-4"
                          : "hover:bg-gray-4"
                      )}
                      onClick={async () => {
                        await updateActiveSpace(space.space.id);
                        router.push("/dashboard/shared-caps");
                      }}
                    >
                      <Avatar
                        letterClass="text-gray-1 text-xs"
                        className="flex-shrink-0 size-5"
                        name={space.space.name}
                      />
                      {!collapsed && (
                        <span className="text-sm text-gray-12 truncate">
                          {space.space.name}
                        </span>
                      )}
                    </div>
                  </Tooltip>
                ))}
              </div>
            </div>
          </div>
        </div>
        <div className="pb-0 w-full lg:pb-5 text-center">
          <UsageButton
            collapsed={collapsed ?? false}
            subscribed={isSubscribed}
          />
          <Link
            href="/download"
            className="inline-flex mt-3 text-xs text-center truncate font-semibold text-gray-10 hover:text-gray-12 hover:underline"
          >
            Download App
          </Link>
          <p className="mt-1 text-xs text-center truncate text-gray-10">
            Cap Software, Inc. {new Date().getFullYear()}.
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
