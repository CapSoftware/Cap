"use client";

import { Card, CardHeader } from "@cap/ui";
import Link from "next/link";
import { usePathname } from "next/navigation";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  const secondaryNavigation = [
    { name: "Account", href: "/dashboard/settings" },
    { name: "Workspace", href: "/dashboard/settings/workspace" },
  ];

  return (
    <div>
      <Card>
        <CardHeader>
          <nav>
            <ul className="inline-flex rounded-lg bg-gray-50 p-1 border-[1px] border-gray-200">
              {secondaryNavigation.map((item) => (
                <li key={item.name}>
                  <Link
                    href={item.href}
                    className={`block rounded-md px-3 py-2 text-xs ${
                      item.href === pathname
                        ? "bg-gray-200 text-gray-900"
                        : "text-gray-500 hover:bg-gray-100 hover:text-gray-900"
                    }`}
                  >
                    {item.name}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </CardHeader>
        {children}
      </Card>
    </div>
  );
}
