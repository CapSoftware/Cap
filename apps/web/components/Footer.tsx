"use client";

import { usePathname } from "next/navigation";
import { Logo, LogoBadge } from "@cap/ui";

export const Footer = () => {
  const pathname = usePathname();

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
    <footer>
      <div className="wrapper min-h-[500px] bg-white rounded-tr-xl rounded-tl-xl p-8 md:p-12 shadow-xl border-l border-t border-r relative overflow-hidden">
        <div className="grid grid-cols-1 md:grid-cols-12 gap-8 items-start justify-between z-10 relative">
          <div className="space-y-4 md:col-span-6">
            <Logo showBeta={true} className="w-24 h-auto" />
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
          <div className="space-y-4 md:col-span-3">
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
          <div className="space-y-4 md:col-span-3">
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
        </div>
        <div className="absolute left-1/2 transform -translate-x-1/2 bottom-0 rotate-45 pointer-events-none">
          <LogoBadge className="w-[650px] h-auto opacity-10 pointer-events-none" />
        </div>
      </div>
    </footer>
  );
};
