"use client";

import { useEffect } from "react";
import Script from "next/script";
import { users } from "@cap/database/schema";
import { Router } from "next/router";

declare global {
  interface Window {
    bento?: any;
  }
}

export function BentoScript({
  user,
}: {
  user: typeof users.$inferSelect | null;
}) {
  useEffect(() => {
    const handleRouteChange = () => {
      console.log("route change");
      setTimeout(() => {
        if (window.bento !== undefined) {
          if (user) {
            window.bento.identify(user.email);
          }
          window.bento.view();
        }
      }, 0);
    };

    Router.events.on("routeChangeComplete", handleRouteChange);

    return () => {
      Router.events.off("routeChangeComplete", handleRouteChange);
    };
  }, []);

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
