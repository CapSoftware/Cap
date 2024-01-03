"use client";

import { usePathname } from "next/navigation";

export const Footer = () => {
  const pathname = usePathname();

  if (pathname === "/login" || pathname.includes("/dashboard")) return null;

  return (
    <footer className="py-4 border-t">
      <div className="wrapper text-center">
        <p className="text-xs text-black">
          © Cap Software, Inc. {new Date().getFullYear()}.
        </p>
      </div>
    </footer>
  );
};
