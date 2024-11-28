"use client";

import { usePathname } from "next/navigation";
import { Logo, LogoBadge } from "@cap/ui";

export const Footer = () => {
  const pathname = usePathname();

  if (
    pathname === "/login" ||
    pathname === "/s" ||
    pathname.includes("/dashboard") ||
    pathname.includes("/invite") ||
    pathname.includes("/s/") ||
    pathname.includes("/onboarding") ||
    pathname.includes("/record") ||
    (typeof window !== "undefined" && window.location.href.includes("cap.link"))
  )
    return null;

  return (
    <footer className="p-5">
      <div
        style={{ boxShadow: "0px 2px 8px rgba(18, 22, 31, 0.02)" }}
        className="mx-auto max-w-[1400px] bg-gray-100 border-[1px] border-gray-200 p-8 lg:p-12 rounded-[20px] mb-10 relative overflow-hidden"
      >
        <div className="sm:grid space-y-8 sm:space-y-0 grid-cols-1 lg:grid-cols-12 gap-8 sm:items-start sm:justify-between z-10 relative">
          <div className="space-y-2 sm:space-y-4 col-span-12 lg:col-span-6">
            <Logo showBeta={true} className="w-[104px] h-auto" />
            <div className="w-full">
              <p className="text-gray-500 max-w-md">
                Cap is the open source alternative to Loom. Lightweight,
                powerful, and stunning. Record and share in seconds.
              </p>
            </div>
            <p className="text-gray-400">
              © Cap Software, Inc. {new Date().getFullYear()}.
            </p>
            <div className="flex space-x-3">
              <a className="text-gray-400 text-sm" href="/terms">
                Terms of Service
              </a>
              <a className="text-gray-400 text-sm" href="/privacy">
                Privacy Policy
              </a>
            </div>
          </div>
          <div className="space-y-4 col-span-12 sm:col-span-6 lg:col-span-2">
            <h3 className="text-lg font-semibold">Product</h3>
            <ul className="space-y-2">
              <li>
                <a href="/updates">Updates</a>
              </li>
              <li>
                <a href="/docs">Docs</a>
              </li>
              <li>
                <a href="/pricing">Pricing</a>
              </li>
              <li>
                <a href="/download">Download</a>
              </li>
              <li>
                <a href="https://github.com/CapSoftware/Cap" target="_blank">
                  Open Source
                </a>
              </li>
              <li>
                <a href="https://discord.gg/y8gdQ3WRN3" target="_blank">
                  Join the community
                </a>
              </li>
            </ul>
          </div>
          <div className="space-y-4 col-span-12 sm:col-span-6 lg:col-span-2">
            <h3 className="text-lg font-semibold">Help</h3>
            <ul className="space-y-2">
              <li>
                <a href="/faq">FAQs</a>
              </li>
              <li>
                <a href="mailto:hello@cap.so">Email Support</a>
              </li>
              <li>
                <a href="https://discord.gg/y8gdQ3WRN3" target="_blank">
                  Chat Support
                </a>
              </li>
              <li>
                <a href="https://cap.openstatus.dev/" target="_blank">
                  System Status
                </a>
              </li>
            </ul>
          </div>
          <div className="space-y-4 col-span-12 sm:col-span-6 lg:col-span-2">
            <h3 className="text-lg font-semibold">Socials</h3>
            <ul className="space-y-2">
              <li>
                <a href="https://x.com/cap" target="_blank">
                  X (@Cap)
                </a>
              </li>
              <li>
                <a href="https://discord.gg/y8gdQ3WRN3" target="_blank">
                  Discord
                </a>
              </li>
              <li>
                <a
                  href="https://linkedin.com/company/capsoftware"
                  target="_blank"
                >
                  LinkedIn
                </a>
              </li>
            </ul>
          </div>
          <div className="space-y-4 col-span-12 sm:col-span-6 lg:col-span-5">
            <h3 className="text-lg font-semibold">Additional Links</h3>
            <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <li>
                <a href="/screen-recorder">Screen Recorder</a>
              </li>
              <li>
                <a href="/free-screen-recorder">Free Screen Recorder</a>
              </li>
              <li>
                <a href="/screen-recorder-mac">Screen Recorder for Mac</a>
              </li>
              <li>
                <a href="/screen-recording-software">
                  Screen Recording Software
                </a>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </footer>
  );
};
