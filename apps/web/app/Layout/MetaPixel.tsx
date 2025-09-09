"use client";

import { buildEnv } from "@cap/env";
import Script from "next/script";
import { useId, useRef } from "react";

declare global {
  interface Window {
    fbq: (command: string, ...args: unknown[]) => void;
    _fbq: unknown;
  }
}

export function MetaPixel() {
  const pixelInitialized = useRef(false);
  const pixelId = buildEnv.NEXT_PUBLIC_META_PIXEL_ID;
  const scriptId = useId();

  if (!pixelId) {
    return null;
  }

  return (
    <>
      <Script
        id={scriptId}
        strategy="afterInteractive"
        src="https://connect.facebook.net/en_US/fbevents.js"
        onLoad={() => {
          if (
            !pixelInitialized.current &&
            typeof window !== "undefined" &&
            window.fbq &&
            pixelId
          ) {
            window.fbq("init", pixelId);
            window.fbq("track", "PageView");
            pixelInitialized.current = true;
          }
        }}
      />
      <noscript>
        <img
          height="1"
          width="1"
          style={{ display: "none" }}
          src={`https://www.facebook.com/tr?id=${pixelId}&ev=PageView&noscript=1`}
          alt=""
        />
      </noscript>
    </>
  );
}

export function trackMetaEvent(
  eventName: string,
  parameters?: Record<string, unknown>
) {
  if (typeof window !== "undefined" && window.fbq) {
    try {
      window.fbq("track", eventName, parameters);
    } catch (error) {
      console.error(`Error tracking Meta event ${eventName}:`, error);
    }
  }
}
