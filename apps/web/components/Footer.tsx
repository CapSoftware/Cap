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
    <footer>
      <div
        style={{ boxShadow: "0px 2px 8px rgba(18, 22, 31, 0.02)" }}
        className="wrapper bg-gray-100 border-[1px] border-gray-200 p-8 lg:p-12 rounded-[20px] mb-10 relative overflow-hidden"
      >
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start justify-between z-10 relative">
          <div className="space-y-4 lg:col-span-6">
            <Logo showBeta={true} className="w-[104px] h-auto" />
            <p className="text-gray-500 max-w-md">
              Cap is the open source alternative to Loom. Lightweight, powerful,
              and stunning. Record and share in seconds.
            </p>
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
          <div className="space-y-4 lg:col-span-2">
            <h3 className="text-lg font-semibold">Product</h3>
            <ul className="space-y-2">
              <li>
                <a href="/updates">Updates</a>
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
          <div className="space-y-4 lg:col-span-2">
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
          <div className="space-y-4 lg:col-span-2">
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
          <div className="space-y-4 lg:col-span-12">
            <h3 className="text-lg font-semibold">More</h3>
            <ul className="space-y-2">
              <li>
                <a href="/screen-recorder">Screen Recorder</a>
              </li>
              <li>
                <a href="/free-screen-recorder">Free Screen Recorder</a>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </footer>
  );
};
