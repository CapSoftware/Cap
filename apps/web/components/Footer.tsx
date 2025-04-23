"use client";

import { usePathname } from "next/navigation";
import { Logo, LogoBadge } from "@cap/ui";

type FooterLink = {
  label: string;
  href: string;
  isExternal?: boolean;
};

const footerLinks = {
  product: [
    { label: "Blog", href: "/blog" },
    { label: "Docs", href: "/docs" },
    { label: "Pricing", href: "/pricing" },
    { label: "Download", href: "/download" },
    {
      label: "Open Source",
      href: "https://github.com/CapSoftware/Cap",
      isExternal: true,
    },
    { label: "Self-hosting", href: "/self-hosting" },
    {
      label: "Join the community",
      href: "https://discord.gg/y8gdQ3WRN3",
      isExternal: true,
    },
  ] as FooterLink[],
  help: [
    { label: "FAQs", href: "/faq" },
    { label: "Email Support", href: "mailto:hello@cap.so" },
    {
      label: "Chat Support",
      href: "https://discord.gg/y8gdQ3WRN3",
      isExternal: true,
    },
    {
      label: "System Status",
      href: "https://cap.openstatus.dev/",
      isExternal: true,
    },
  ] as FooterLink[],
  socials: [
    { label: "X (@Cap)", href: "https://x.com/cap", isExternal: true },
    {
      label: "Discord",
      href: "https://discord.gg/y8gdQ3WRN3",
      isExternal: true,
    },
    {
      label: "LinkedIn",
      href: "https://www.linkedin.com/company/caprecorder/",
      isExternal: true,
    },
  ] as FooterLink[],
  useCases: [
    {
      label: "Remote Team Collaboration",
      href: "/solutions/remote-team-collaboration",
    },
    {
      label: "Employee Onboarding Platform",
      href: "/solutions/employee-onboarding-platform",
    },
    {
      label: "Daily Standup Software",
      href: "/solutions/daily-standup-software",
    },
    {
      label: "Online Classroom Tools",
      href: "/solutions/online-classroom-tools",
    },
  ] as FooterLink[],
  additional: [
    { label: "Screen Recorder", href: "/screen-recorder" },
    { label: "Free Screen Recorder", href: "/free-screen-recorder" },
    { label: "Screen Recorder for Mac", href: "/screen-recorder-mac" },
    { label: "Screen Recorder for Windows", href: "/screen-recorder-windows" },
    { label: "Screen Recording Software", href: "/screen-recording-software" },
    { label: "Cap vs Loom", href: "/loom-alternative" },
  ] as FooterLink[],
};

export const Footer = () => {
  const pathname = usePathname();

  if (
    pathname === "/login" ||
    pathname === "/s" ||
    pathname.includes("/dashboard") ||
    pathname.includes("/invite") ||
    pathname.includes("/s/") ||
    pathname.includes("/onboarding") ||
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
            <Logo className="w-[104px] h-auto" />
            <div className="w-full">
              <p className="text-gray-500 max-w-md">
                Cap is the open source alternative to Loom. Lightweight,
                powerful, and cross-platform. Record and share in seconds.
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
              {footerLinks.product.map((link, index) => (
                <li key={index}>
                  <a
                    href={link.href}
                    target={link.isExternal ? "_blank" : undefined}
                  >
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
          <div className="space-y-4 col-span-12 sm:col-span-6 lg:col-span-2">
            <h3 className="text-lg font-semibold">Help</h3>
            <ul className="space-y-2">
              {footerLinks.help.map((link, index) => (
                <li key={index}>
                  <a
                    href={link.href}
                    target={link.isExternal ? "_blank" : undefined}
                  >
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
          <div className="space-y-4 col-span-12 sm:col-span-6 lg:col-span-2">
            <h3 className="text-lg font-semibold">Socials</h3>
            <ul className="space-y-2">
              {footerLinks.socials.map((link, index) => (
                <li key={index}>
                  <a
                    href={link.href}
                    target={link.isExternal ? "_blank" : undefined}
                  >
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
          <div className="space-y-4 col-span-12 sm:col-span-6 lg:col-span-12">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
              <div className="space-y-4">
                <h3 className="text-lg font-semibold">Additional Links</h3>
                <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {footerLinks.additional.map((link, index) => (
                    <li key={index}>
                      <a
                        href={link.href}
                        target={link.isExternal ? "_blank" : undefined}
                      >
                        {link.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="space-y-4">
                <h3 className="text-lg font-semibold">Use Cases</h3>
                <ul className="grid grid-cols-1 gap-2">
                  {footerLinks.useCases.map((link, index) => (
                    <li key={index}>
                      <a
                        href={link.href}
                        target={link.isExternal ? "_blank" : undefined}
                      >
                        {link.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </div>
      </div>
    </footer>
  );
};
