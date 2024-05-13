"use client";

import { usePathname } from "next/navigation";
import { Button, ListItem } from "@cap/ui";
import {
  NavigationMenu,
  NavigationMenuContent,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
  NavigationMenuTrigger,
  Logo,
  navigationMenuTriggerStyle,
} from "@cap/ui";
import Link from "next/link";
import { useState } from "react";
import { Menu, X } from "lucide-react";

export const Navbar = ({ auth }: { auth: boolean }) => {
  const pathname = usePathname();
  const isHomePage = pathname === "/";
  const [showMobileMenu, setShowMobileMenu] = useState(false);

  if (
    pathname === "/login" ||
    pathname.includes("/dashboard") ||
    pathname.includes("/s/") ||
    pathname.includes("/onboarding") ||
    pathname.includes("/record") ||
    (typeof window !== "undefined" && window.location.href.includes("cap.link"))
  )
    return null;

  return (
    <>
      <div
        className={`${
          isHomePage === true
            ? "bg-transparent border-transparent"
            : "bg-white border-gray-100"
        } border-b-2 z-20 p-5 relative transition-all flex justify-between w-full max-w-3xl mx-auto`}
      >
        <div>
          <a href="/">
            <Logo showBeta={true} className="w-20 sm:w-24 h-auto" />
          </a>
        </div>
        <div className="block md:hidden">
          <button onClick={() => setShowMobileMenu(!showMobileMenu)}>
            <Menu className="w-[28px] h-[28px]" />
          </button>
        </div>
        <div className="hidden md:block">
          <NavigationMenu>
            <NavigationMenuList>
              <NavigationMenuItem>
                <NavigationMenuTrigger>Product</NavigationMenuTrigger>
                <NavigationMenuContent>
                  <ul className="grid gap-3 p-6 md:w-[400px] lg:w-[500px] lg:grid-cols-2">
                    <ListItem href="/record" title="Web App Recorder">
                      Use Cap in your browser, no download required.
                    </ListItem>
                    <ListItem href="/download" title="Download macOS App">
                      Download for macOS. Windows and Linux coming soon.
                    </ListItem>
                    <ListItem
                      href="https://github.com/CapSoftware/Cap"
                      title="Open source"
                      target="_blank"
                    >
                      Cap is open source and available on GitHub.
                    </ListItem>
                    <ListItem
                      href="https://discord.gg/y8gdQ3WRN3"
                      title="Join the community"
                      target="_blank"
                    >
                      Join the Cap discord community.
                    </ListItem>
                  </ul>
                </NavigationMenuContent>
              </NavigationMenuItem>
              <NavigationMenuItem>
                <Link href="/pricing" legacyBehavior passHref>
                  <NavigationMenuLink className={navigationMenuTriggerStyle()}>
                    Pricing
                  </NavigationMenuLink>
                </Link>
              </NavigationMenuItem>
              <NavigationMenuItem>
                <Link href="/updates" legacyBehavior passHref>
                  <NavigationMenuLink className={navigationMenuTriggerStyle()}>
                    Updates
                  </NavigationMenuLink>
                </Link>
              </NavigationMenuItem>
              <NavigationMenuItem>
                <NavigationMenuTrigger>Help</NavigationMenuTrigger>
                <NavigationMenuContent>
                  <ul className="grid gap-3 p-6 md:w-[400px] lg:w-[500px] lg:grid-cols-[.75fr_1fr]">
                    <ListItem href="/faq" title="FAQs">
                      Frequently asked questions about Cap.
                    </ListItem>
                    <ListItem href="mailto:hello@cap.so" title="Email support">
                      Support via email
                    </ListItem>
                    <ListItem
                      href="https://discord.gg/y8gdQ3WRN3"
                      target="_blank"
                      title="Chat support"
                    >
                      Support via Discord chat
                    </ListItem>
                    <ListItem href="/roadmap" title="Roadmap">
                      Upcoming features and improvements.
                    </ListItem>
                  </ul>
                </NavigationMenuContent>
              </NavigationMenuItem>
              <NavigationMenuItem>
                <Button
                  className={auth === false ? "min-w-[155px]" : ""}
                  href={auth === false ? "/login" : "/dashboard"}
                  size="sm"
                >
                  {auth === false ? "Get started for free" : "Dashboard"}
                </Button>
              </NavigationMenuItem>
              <NavigationMenuItem className="pl-3">
                <Link
                  href="https://github.com/CapSoftware/Cap"
                  passHref
                  target="_blank"
                  className="flex items-center"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    fill="currentColor"
                    className="w-7 h-7"
                    viewBox="0 0 24 24"
                  >
                    <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"></path>
                  </svg>
                </Link>
              </NavigationMenuItem>
            </NavigationMenuList>
          </NavigationMenu>
        </div>
      </div>
      {showMobileMenu && (
        <div className="fixed top-0 left-0 w-full h-full px-5 bg-white z-[100000] overflow-auto">
          <div className="bg-gradient-to-b from-white to-[rgba(255,255,255,0.3)] pt-5 pb-12 sticky top-0 flex items-center justify-between">
            <Link href="/">
              <Logo showBeta={true} className="w-20 sm:w-24 h-auto" />
            </Link>
            <button onClick={() => setShowMobileMenu(!showMobileMenu)}>
              <X className="w-[28px] h-[28px]" />
            </button>
          </div>
          <div className="pb-12">
            <nav className="mobile relative">
              <ul className="p-0 space-y-10">
                <li>
                  <Link
                    onClick={() => {
                      setShowMobileMenu(false);
                    }}
                    href="/pricing"
                    passHref
                  >
                    Pricing
                  </Link>
                </li>
                <li>
                  <Link
                    onClick={() => {
                      setShowMobileMenu(false);
                    }}
                    href="/download"
                    passHref
                  >
                    Download
                  </Link>
                </li>
                <li>
                  <Link
                    onClick={() => {
                      setShowMobileMenu(false);
                    }}
                    href="/login"
                    passHref
                  >
                    Get started
                  </Link>
                </li>
                <li>
                  <Link
                    href="https://github.com/CapSoftware/Cap"
                    passHref
                    target="_blank"
                    className="flex items-center"
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      fill="currentColor"
                      className="w-6 h-6"
                      viewBox="0 0 24 24"
                    >
                      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"></path>
                    </svg>
                    <span className="ml-2">Open Source</span>
                  </Link>
                </li>
                <li>
                  <Link
                    href="https://discord.gg/y8gdQ3WRN3"
                    passHref
                    target="_blank"
                    className="flex items-center"
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      fill="currentColor"
                      className="w-6 h-6"
                      viewBox="0 0 24 24"
                    >
                      <path d="M20.317 4.37a19.791 19.791 0 00-4.885-1.515.074.074 0 00-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 00-5.487 0 12.64 12.64 0 00-.617-1.25.077.077 0 00-.079-.037A19.736 19.736 0 003.677 4.37a.07.07 0 00-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 00.031.057 19.9 19.9 0 005.993 3.03.078.078 0 00.084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 00-.041-.106 13.107 13.107 0 01-1.872-.892.077.077 0 01-.008-.128 10.2 10.2 0 00.372-.292.074.074 0 01.077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 01.078.01c.12.098.246.198.373.292a.077.077 0 01-.006.127 12.299 12.299 0 01-1.873.892.077.077 0 00-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 00.084.028 19.839 19.839 0 006.002-3.03.077.077 0 00.032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 00-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"></path>
                    </svg>
                    <span className="ml-2">Join the community</span>
                  </Link>
                </li>
                <li>
                  <Button
                    href={auth === false ? "/login" : "/dashboard"}
                    size="lg"
                  >
                    {auth === false ? "Get started for free" : "Dashboard"}
                  </Button>
                </li>
              </ul>
            </nav>
          </div>
        </div>
      )}
    </>
  );
};
