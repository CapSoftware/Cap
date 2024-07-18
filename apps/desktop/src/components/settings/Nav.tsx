"use client";

import { BadgeInfo, Settings, UserRound } from "lucide-react";

import HistoryButtons from "./HistoryButtons";
import Link from "next/link";
import { usePathname } from "next/navigation";

export default function Nav() {
  const pathname = usePathname();
  const navGroups = {
    app: [
      {
        name: "About",
        icon: <BadgeInfo />,
        link: "/settings/about",
      },
      {
        name: "Settings",
        icon: <Settings />,
        link: "/settings",
      },
    ],
    resources: [],
  };
  return (
    <div className='w-1/6 min-h-screen bg-white border-r-2  border-[#eee] p-4 max-h-screen overflow-scroll'>
      <HistoryButtons />
      <div className='mt-6 flex-col gap-6'>
        {Object.entries(navGroups).map(([key, value]) => (
          <div key={key} className='my-2'>
            <h5 className='text-[#A2A6AA] text-xs capitalize font-bold'>
              {key}
            </h5>
            <ul className='mt-2 flex flex-col gap-2 w-full'>
              {value.map((navItem) => (
                <li
                  key={navItem.name}
                  className='flex items-center gap-2 text-[#575759] rounded-md hover:bg-[#E9E9EB]'>
                  <Link
                    href={navItem.link}
                    className={`transition-colors duration-200 ${
                      pathname === navItem.link
                        ? "font-extrabold hover:text-primary/80"
                        : "text-muted-foreground hover:text-primary"
                    } text-xs font-semibold flex items-center gap-3 px-3 py-1 rounded`}>
                    <span>{navItem.icon}</span>
                    <span>{navItem.name}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
