"use client";

import Link from "next/link";
import { Button } from "@cap/ui";
import { useEffect } from "react";

interface ToolCategory {
  title: string;
  description: string;
  href: string;
  icon: string;
}

const toolCategories: ToolCategory[] = [
  {
    title: "File Conversion",
    description:
      "Convert between different file formats directly in your browser",
    href: "/tools/convert",
    icon: "M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z",
  },
  {
    title: "Video Speed Controller",
    description: "Speed up or slow down your videos without losing quality",
    href: "/tools/video-speed-controller",
    icon: "M15.75 5.25a3 3 0 013 3m-3-3a3 3 0 00-3 3m3-3v1.5m0 9.75a3 3 0 01-3-3m3 3a3 3 0 003-3m-3 3v-1.5m-6-1.5h.008v.008H7.5v-.008zm1.5-9h.375c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-.375m1.5-4.5A1.125 1.125 0 0110.375 7.5h-1.5A1.125 1.125 0 017.75 8.625M10.5 12a.375.375 0 11-.75 0 .375.375 0 01.75 0z",
  },
];

export function ToolsPageContent() {
  useEffect(() => {
    const animateClouds = () => {
      const cloud1 = document.getElementById("cloud-1");
      const cloud2 = document.getElementById("cloud-2");

      if (cloud1 && cloud2) {
        cloud1.animate(
          [
            { transform: "translateX(0) translateY(0)" },
            { transform: "translateX(-10px) translateY(5px)" },
            { transform: "translateX(10px) translateY(-5px)" },
            { transform: "translateX(0) translateY(0)" },
          ],
          {
            duration: 15000,
            iterations: Infinity,
            easing: "ease-in-out",
          }
        );

        cloud2.animate(
          [
            { transform: "translateX(0) translateY(0)" },
            { transform: "translateX(10px) translateY(-5px)" },
            { transform: "translateX(-10px) translateY(5px)" },
            { transform: "translateX(0) translateY(0)" },
          ],
          {
            duration: 18000,
            iterations: Infinity,
            easing: "ease-in-out",
          }
        );
      }
    };

    animateClouds();
  }, []);

  return (
    <div className="py-20 md:py-28">
      <div className="wrapper">
        <div className="text-center mb-12">
          <h1 className="text-4xl font-bold tracking-tight text-gray-900 mb-4">
            Try our free tools
          </h1>
          <p className="text-xl text-gray-600 max-w-3xl mx-auto">
            Powerful browser-based utilities that run directly on your device.
            No uploads, no installations, maximum privacy.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-3">
          {toolCategories.map((category) => (
            <Link
              key={category.href}
              href={category.href}
              className="group block p-8 border border-gray-200 rounded-xl hover:border-blue-500 hover:shadow-md transition-all"
            >
              <div className="flex flex-col items-center text-center">
                <div className="flex-shrink-0 p-3 bg-blue-100 rounded-xl mb-5">
                  <svg
                    className="w-8 h-8 text-blue-600"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={1.5}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d={category.icon}
                    />
                  </svg>
                </div>
                <h2 className="text-2xl font-semibold text-gray-900 group-hover:text-blue-600 transition-colors mb-3">
                  {category.title}
                </h2>
                <p className="text-gray-600">{category.description}</p>
              </div>
            </Link>
          ))}
        </div>

        <div
          className="mx-auto mt-16 mb-8 rounded-3xl overflow-hidden relative flex flex-col justify-center p-12"
          style={{
            minHeight: "300px",
            background:
              "linear-gradient(135deg, #4f46e5 0%, #3b82f6 50%, #0ea5e9 100%)",
          }}
        >
          <div
            id="cloud-1"
            className="absolute top-0 -right-20 opacity-30 z-0 pointer-events-none transition-transform duration-700 ease-in-out"
          >
            <img
              className="max-w-[40vw] h-auto"
              src="/illustrations/cloud-1.png"
              alt="Footer Cloud One"
            />
          </div>
          <div
            id="cloud-2"
            className="absolute bottom-0 left-0 opacity-30 z-0 pointer-events-none transition-transform duration-700 ease-in-out"
          >
            <img
              className="max-w-[40vw] h-auto"
              src="/illustrations/cloud-2.png"
              alt="Footer Cloud Two"
            />
          </div>
          <div className="wrapper mx-auto h-full flex flex-col justify-center items-center relative z-10">
            <div className="text-center max-w-[800px] mx-auto mb-8">
              <h2 className="text-3xl md:text-4xl font-bold text-white mb-4 drop-shadow-md">
                The open source Loom alternative
              </h2>
              <p className="text-xl text-white/90 mb-6">
                Cap is lightweight, powerful, and cross-platform. Record and
                share securely in seconds with custom S3 bucket support.
              </p>
            </div>
            <div className="flex flex-col sm:flex-row items-center justify-center space-y-3 sm:space-y-0 sm:space-x-4">
              <Button
                variant="white"
                href="/download"
                size="lg"
                className="w-full sm:w-auto transition-all duration-300 font-medium px-8 py-3"
              >
                Download Cap Free
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
