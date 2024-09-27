// million-ignore

"use client";

import { Parallax } from "react-scroll-parallax";
import toast from "react-hot-toast";
import { ParallaxProvider } from "react-scroll-parallax";
import { Button } from "@cap/ui";
import Link from "next/link";
import { useEffect } from "react";

export const HomePage = () => {
  useEffect(() => {
    const animateClouds = () => {
      const cloud1 = document.getElementById("cloud-1");
      const cloud2 = document.getElementById("cloud-2");
      const cloud3 = document.getElementById("cloud-3");

      if (cloud1 && cloud2 && cloud3) {
        // Animate cloud 1 to the left
        cloud1.animate(
          [
            { transform: "translateX(200px)" },
            { transform: "translateX(-50px)" },
            { transform: "translateX(0)" },
          ],
          {
            duration: 100000,
            iterations: Infinity,
          }
        );

        // Animate cloud 2 to the right
        cloud2.animate(
          [
            { transform: "translateX(-200px)" },
            { transform: "translateX(50px)" },
            { transform: "translateX(0)" },
          ],
          {
            duration: 120000,
            iterations: Infinity,
          }
        );

        // Animate cloud 3 down
        cloud3.animate(
          [
            { transform: "translateY(100px)" },
            { transform: "translateY(-30px)" },
            { transform: "translateY(0)" },
          ],
          {
            duration: 150000,
            iterations: Infinity,
          }
        );
      }
    };

    animateClouds();
  }, []);

  return (
    <ParallaxProvider>
      <div className="-mt-[80px] custom-bg min-h-screen md:min-h-[calc(100vh+20px)] relative flex items-center">
        <div className="w-full relative z-10 flex">
          <div className="wrapper wrapper-sm mx-auto">
            <div className="mb-auto text-center px-4 pt-40 pb-52 md:pb-64 -mt-40">
              {/* <Link
                href="/updates/cap-public-beta-launch"
                target="_blank"
                className="mx-auto mb-4 inline-flex justify-center font-medium transition-colors focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 bg-blue-400 hover:bg-blue-500 h-9 px-4 py-2 rounded-full space-x-2 items-center"
              >
                <span className="text-sm text-white">
                  NEW: Cap v0.3 is here!
                </span>
                <svg
                  className="text-white"
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
              </Link> */}

              <h1 className="fade-in-down text-[2rem] leading-[2.5rem] md:text-[3.75rem] md:leading-[4rem] relative z-10 text-white mb-4">
                Beautiful, shareable screen recordings.
              </h1>
              <p className="fade-in-down animate-delay-1 text-base sm:text-xl max-w-2xl mx-auto text-white mb-8">
                Cap is the open source alternative to Loom. Lightweight,
                powerful, and stunning. Record and share in seconds.
              </p>
              <div className="fade-in-up animate-delay-2">
                <div className="flex flex-col sm:flex-row items-center justify-center space-y-2 sm:space-y-0 sm:space-x-2 mb-3">
                  <Button
                    variant="white"
                    href="/pricing"
                    size="lg"
                    className="w-full sm:w-auto"
                  >
                    Get Started
                  </Button>
                  <Button
                    variant="secondary"
                    href="/download"
                    size="lg"
                    className="w-full sm:w-auto"
                  >
                    Download App
                  </Button>
                </div>
                <p className="text-gray-200 text-sm">
                  No credit card required.
                </p>
              </div>
            </div>
          </div>
        </div>
        <div id="cloud-1" className="absolute top-0 -right-20 opacity-70">
          <img
            className="max-w-[40vw] h-auto"
            src="/illustrations/cloud-1.png"
            alt="Homepage Cloud One"
          />
        </div>
        <div id="cloud-2" className="absolute top-0 left-0 opacity-70">
          <img
            className="max-w-[40vw] h-auto"
            src="/illustrations/cloud-2.png"
            alt="Homepage Cloud Two"
          />
        </div>
        <div id="cloud-3" className="absolute -bottom-10 -left-20 opacity-70">
          <img src="/illustrations/cloud-3.png" alt="Homepage Cloud Three" />
        </div>
      </div>
      <div
        id="scrolling-section"
        className="pb-48 fade-in-up animate-delay-2 -mt-40"
      >
        <Parallax
          className="cursor-pointer"
          scale={[2.2, 1.25]}
          onClick={() =>
            toast("This was going to be something cool... it might be later 👀")
          }
        >
          <img
            src="/illustrations/landing-banner.png"
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
    </ParallaxProvider>
  );
};
