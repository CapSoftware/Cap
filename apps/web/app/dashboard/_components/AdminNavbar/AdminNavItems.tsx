"use client";
import { usePathname, useRouter } from "next/navigation";
import {
  Plus,
  Settings,
  LogOut,
  ChevronDown,
  Clapperboard,
  Video,
  Download,
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

export const AdminNavItems = () => {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const { spaceData, activeSpace } = useSharedContext();

  const manageNavigation = [
    {
      name: "My Caps",
      href: `/dashboard/caps`,
      icon: Clapperboard,
      subNav: [],
    },
    {
      name: "Download App",
      href: `/download`,
      icon: Download,
      subNav: [],
    },
    {
      name: "Settings",
      href: `/dashboard/settings`,
      icon: Settings,
      subNav: [
        { name: "My account", href: `/dashboard/settings` },
        { name: "Billing", href: `/dashboard/settings/billing` },
      ],
    },
  ];

  const navItemClass =
    "flex items-center justify-start py-2 px-3 rounded-full outline-none tracking-tight w-full";

  return (
    <Dialog>
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
                    {activeSpace?.name ?? "No space found"}
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
                {spaceData !== null &&
                  spaceData?.map((space) => (
                    <CommandItem
                      key={space.name + "-space"}
                      // onSelect={async () => {
                      //   await handleActiveSpace(space.id);
                      //   router.refresh();
                      //   setOpen(false);
                      // }}
                    >
                      {space.name}
                    </CommandItem>
                  ))}
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
                    "flex-shrink-0 w-6 h-6 stroke-[1.8px]",
                    pathname.includes(item.href) ? "text-black" : ""
                  )}
                  aria-hidden="true"
                />
                <span className="text-base ml-2.5 text-black">{item.name}</span>
              </Link>
              {pathname.includes(item.href) && item.subNav.length > 0 && (
                <div className="mt-1 space-y-1 flex-grow w-full">
                  {item.subNav.map((subItem) => (
                    <Link
                      passHref
                      prefetch={false}
                      key={subItem.name + "-sub"}
                      href={subItem.href}
                      className={classNames(
                        pathname === subItem.href
                          ? "bg-white text-black border-[1px] border-gray-200"
                          : "opacity-50 hover:opacity-75",
                        navItemClass
                      )}
                    >
                      <div className="w-6 h-6"></div>
                      <span className="text-base ml-2.5">{subItem.name}</span>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="mt-auto">
          <div className="w-full mb-3 pb-5 border-b-2 border-gray-200 border-dotted">
            <UsageButton />
          </div>
          <button
            onClick={() => signOut()}
            className={classNames("opacity-75 hover:opacity-100", navItemClass)}
          >
            <LogOut className="flex-shrink-0 w-6 h-6" aria-hidden="true" />
            <span className="text-base ml-2.5">Sign out</span>
          </button>
        </div>
      </nav>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create a new Space</DialogTitle>
          <DialogDescription>
            This feature is launching very soon.
          </DialogDescription>
        </DialogHeader>
        <DialogDescription>
          <NewSpace />
        </DialogDescription>
      </DialogContent>
    </Dialog>
  );
};

export default AdminNavItems;
