"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  const secondaryNavigation = [
    { name: "My account", title: "Settings", href: "/dashboard/settings" },
    { name: "Billing", title: "Billing", href: "/dashboard/settings/billing" },
  ];

  const currentPage = secondaryNavigation.find(
    (item) => item.href === pathname
  );

  return (
    <div>
      <header className="border-b border-white/5">
        <h1 className="text-3xl">{currentPage?.title ?? "Settings"}</h1>
        <nav className="mb-4 flex overflow-x-auto py-4">
          <ul
            role="list"
            className="flex min-w-full flex-none gap-x-6 text-sm leading-6 text-gray-400 p-0"
          >
            {secondaryNavigation.map((item, index) => (
              <li key={index}>
                <Link
                  href={item.href}
                  className={`${
                    item.href === pathname
                      ? "text-black border-black primary font-medium"
                      : "text-gray-900 opacity-50 hover:opacity-100 border-transparent"
                  } pb-2 border-b-2`}
                >
                  {item.name}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </header>
      {children}
    </div>
  );
}
