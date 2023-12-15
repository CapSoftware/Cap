"use client";
import { usePathname, useRouter } from "next/navigation";
import { useSupabase } from "@/utils/database/supabase/provider";
import {
  Plus,
  Settings,
  LogOut,
  ChevronDown,
  Clapperboard,
  Bell,
  History,
} from "lucide-react";
import Link from "next/link";
import { classNames } from "@/utils/helpers";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
} from "ui";
import { Popover, PopoverContent, PopoverTrigger } from "ui";
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "ui";
import { NewSpace } from "@/components/forms/NewSpace";
import { useSharedContext } from "@/app/dashboard/_components/DynamicSharedLayout";
import { handleActiveSpace } from "@/utils/database/supabase/helpers";

export const AdminNavItems = () => {
  const pathname = usePathname();
  const { supabase } = useSupabase();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const { spaceData, activeSpace } = useSharedContext();

  const manageNavigation = [
    { name: "My Caps", href: `/dashboard/caps`, icon: Clapperboard },
    { name: "Notifications", href: `/dashboard/notifications`, icon: Bell },
    { name: "History", href: `/dashboard/history`, icon: History },
    { name: "Settings", href: `/dashboard/settings`, icon: Settings },
  ];

  const navItemClass =
    "flex items-center justify-start p-2 rounded-lg border border-transparent outline-none w-full";

  const handleLogout = async () => {
    const { error } = await supabase.auth.signOut();

    router.refresh();

    if (error) {
      console.log({ error });
    }
  };

  return (
    <>
      <Dialog>
        <div className="embossed mt-8 mb-4 w-full">
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <div
                className="flex items-center justify-between py-2 px-4 cursor-pointer"
                role="combobox"
                aria-expanded={open}
              >
                <div className="flex items-center w-full text-left">
                  <div>
                    <p className="text-sm">Spaces</p>
                    <p className="font-medium">
                      {activeSpace?.name ?? "No space found"}
                    </p>
                  </div>
                </div>
                <div>
                  <ChevronDown className="w-[20px] h-auto" />
                </div>
              </div>
            </PopoverTrigger>
            <PopoverContent className="w-full p-0 z-10 bg-white">
              <Command>
                <CommandInput placeholder="Search spaces..." />
                <CommandEmpty>No spaces found.</CommandEmpty>
                <CommandGroup>
                  {spaceData?.map((space) => (
                    <CommandItem
                      key={space.name}
                      onSelect={async () => {
                        await handleActiveSpace(space.id, supabase);
                        router.refresh();
                        setOpen(false);
                      }}
                    >
                      {space.name}
                    </CommandItem>
                  ))}
                  <DialogTrigger className="w-full">
                    <CommandItem className="bg-filler aria-selected:bg-filler-2 rounded-lg">
                      <Plus className="w-4 h-auto mr-1" />
                      <span>Add new space</span>
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
              <Link
                passHref
                prefetch={false}
                key={item.name}
                href={item.href}
                className={classNames(
                  pathname == item.href
                    ? "bg-gradient-to-l from-tertiary-3 to-tertiary-2 border-tertiary-2"
                    : "opacity-75 hover:opacity-100 border-transparent",
                  navItemClass
                )}
              >
                <item.icon
                  className="flex-shrink-0 w-6 h-6 stroke-[1.8px]"
                  aria-hidden="true"
                />
                <span className="text-base ml-2.5">{item.name}</span>
              </Link>
            ))}
          </div>
          <div className="mt-auto">
            <button
              onClick={handleLogout}
              className={classNames("hover:opacity-75", navItemClass)}
            >
              <LogOut className="flex-shrink-0 w-6 h-6" aria-hidden="true" />
              <span className="text-base ml-2.5">Sign out</span>
            </button>
          </div>
        </nav>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create a new Space</DialogTitle>
          </DialogHeader>
          <DialogDescription>
            <NewSpace />
          </DialogDescription>
        </DialogContent>
      </Dialog>
    </>
  );
};

export default AdminNavItems;
