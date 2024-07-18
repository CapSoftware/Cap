"use client";

export const dynamic = "force-static";

import { CloseX } from "@/components/icons/CloseX";
import Link from "next/link";
import { NavigationMenu } from "@cap/ui";
import { closeSettingsWindow } from "@/utils/helpers";
import { usePathname } from "next/navigation";
export default function SettingsPage({ children }) {
  const pathname = usePathname();
  return (
    <div className='flex min-h-screen w-full flex-col bg-gray-100'>
      <header className='sticky top-0 flex h-16 items-center gap-4 border-b bg-background px-4 md:px-6'>
        <h3> Settings</h3>
        <div className='flex w-full items-center gap-4 md:ml-auto md:gap-2 lg:gap-4'>
          <form className='ml-auto flex-1 sm:flex-initial'>
            <div className='relative'>
              <button className='cursor-pointer' onClick={closeSettingsWindow}>
                <CloseX className='w-5 h-5' />
              </button>
            </div>
          </form>
        </div>
      </header>
      <main className='flex min-h-[calc(100vh_-_theme(spacing.16))] flex-1 flex-col gap-4 bg-muted/40 p-4 md:gap-8 md:p-10'>
        <div className='mx-auto grid w-full max-w-6xl items-start gap-6 md:grid-cols-[180px_1px_1fr] lg:grid-cols-[250px_1px_1fr]'>
          <nav
            className='grid gap-4 text-sm text-muted-foreground'
            x-chunk='dashboard-04-chunk-0'>
            <Link
              href='/settings/about'
              className={`transition-colors duration-200 ${
                pathname === "/settings/about"
                  ? "font-semibold text-primary hover:text-primary/80"
                  : "text-muted-foreground hover:text-primary"
              }`}>
              About
            </Link>
            <Link
              href='/settings'
              className={`transition-colors duration-200 ${
                pathname === "/settings"
                  ? "font-semibold text-primary hover:text-primary/80"
                  : "text-muted-foreground hover:text-primary"
              }`}>
              Settings
            </Link>
          </nav>
          <div className='hidden md:block bg-gray-200 h-full'></div>
          <div>{children}</div>
        </div>
      </main>
    </div>
  );
}
