"use client";

import { useEffect } from "react";
import Script from "next/script";
import { usePathname, useSearchParams } from "next/navigation";

declare global {
  interface Window {
    bento?: any;
  }
}

export function BentoScript({ userEmail }: { userEmail: string }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (window.bento !== undefined) {
      if (userEmail) {
        window.bento.identify(userEmail);
      }
      window.bento.view();
    }
  }, [pathname, searchParams, userEmail]);

  return (
    <Script
      id="bento-script"
      src={
        "https://fast.bentonow.com?site_uuid=7d5c45ace4c02e5587c4449b1f0efb5c"
      }
      strategy="afterInteractive"
    />
  );
}
