// million-ignore

"use client";

import { Parallax } from "react-scroll-parallax";
import toast from "react-hot-toast";
import { ParallaxProvider } from "react-scroll-parallax";
import { Button } from "@cap/ui";
import Link from "next/link";

export const HomePage = () => {
  return (
    <ParallaxProvider>
      <div className="custom-bg">
        <div className="w-full">
          <div className="wrapper wrapper-sm mx-auto">
            <div className="mb-auto -mt-20 text-center md:px-4 pt-40 pb-52 md:pb-64 space-y-8">
              <Link
                href="/updates/cap-public-beta-launch"
                target="_blank"
                className="mx-auto inline-flex justify-center text-sm font-medium transition-colors focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 border bg-tertiary hover:bg-transparent h-9 px-4 py-2 rounded-full border-border space-x-2 items-center"
              >
                <span>Announcing Cap Public Beta</span>
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width={12}
                  height={12}
                  fill="none"
                >
                  <path
                    fill="currentColor"
                    d="M8.783 6.667H.667V5.333h8.116L5.05 1.6 6 .667 11.333 6 6 11.333l-.95-.933 3.733-3.733Z"
                  />
                </svg>
              </Link>

              <h1 className="fade-in-down text-3xl lg:text-6xl relative z-10 text-black">
                Effortless, instant screen sharing.
              </h1>
              <p className="fade-in-down animate-delay-1 text-base sm:text-xl max-w-2xl mx-auto text-black mb-8">
                Cap is the open source alternative to Loom. Lightweight,
                powerful, and stunning. Record and share in seconds.
              </p>
              <div className="fade-in-up animate-delay-2">
                <div className="flex items-center justify-center space-x-2 mb-3">
                  <Button href="/login" size="lg">
                    Get started for free
                  </Button>
                </div>
                <p className="text-gray-500 text-sm">
                  No credit card required.
                </p>
              </div>
            </div>
          </div>
        </div>
        <div
          id="scrolling-section"
          className="pb-48 fade-in-up animate-delay-2"
        >
          <Parallax
            className="cursor-pointer"
            scale={[2.2, 1.25]}
            onClick={() =>
              toast(
                "This was going to be something cool... it might be later 👀"
              )
            }
          >
            <img
              src="/landing-banner.jpg"
              className="w-full max-w-[600px] block mx-auto h-auto rounded-xl"
              alt="Landing Page Screenshot Banner"
            />
          </Parallax>
        </div>
        <div className="pt-6 pb-16 md:pt-16 md:pb-32">
          <div className="wrapper">
            <div
              className="senja-embed"
              data-id="b40c5cc6-3d88-468e-a763-c7e515c3f000"
              data-lazyload="false"
              data-mode="shadow"
            />
            <script
              async
              src="https://widget.senja.io/widget/b40c5cc6-3d88-468e-a763-c7e515c3f000/platform.js"
              type="text/javascript"
            />
          </div>
        </div>
      </div>
    </ParallaxProvider>
  );
};
