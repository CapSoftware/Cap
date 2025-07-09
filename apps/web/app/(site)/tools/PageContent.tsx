"use client";

import { Button } from "@cap/ui";
import Link from "next/link";
import {motion} from 'framer-motion'
import { useEffect } from "react";
import LeftBlueHue from "@/components/pages/HomePage/LeftBlueHue";

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
  {
    title: "Video Trimmer",
    description: "Cut unwanted sections from videos with precision",
    href: "/tools/trim",
    icon: "M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244",
  },
];

export function PageContent() {
 useEffect(() => {
    const animateClouds = () => {
      const cloud4 = document.getElementById("cloud-4");
      const cloud5 = document.getElementById("cloud-5");

      if (cloud4 && cloud5) {
        cloud4.animate(
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

        cloud5.animate(
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
    <>
     <div
        className="relative overflow-hidden mt-[60px]"
        style={{ height: "calc(100vh - 60px)" }}
      >
        <div className="relative z-10 px-5 w-full h-full flex flex-col justify-center">
          <div className="mx-auto text-center wrapper wrapper-sm">
            <h1 className="fade-in-down text-[2.25rem] leading-[2.75rem] md:text-[3.5rem] md:leading-[4rem] relative z-10 text-black mb-6">
               Try our free tools
            </h1>
            <p className="mx-auto mb-10 max-w-2xl text-md sm:text-xl text-zinc-500 fade-in-down animate-delay-1">
             Powerful browser-based utilities that run directly on your device. No uploads, no installations, maximum privacy.
            </p>
          </div>
          <div className="flex flex-col justify-center items-center space-y-2 fade-in-up animate-delay-2 sm:flex-row sm:space-y-0 sm:space-x-4">
            <Button
              variant="blue"
              size="lg"
              className="relative z-[20] w-full font-medium text-md sm:w-auto"
              onClick={(e) => {
                e.preventDefault();
                const grid = document.querySelector(".wrapper");
                if (grid) {
                  grid.scrollIntoView({ behavior: "smooth" });
                }
              }}
            >
              Start now
            </Button>
          </div>
         

        </div>

        {/** Header BG */}
        <div className="w-full mx-auto overflow-hidden h-[830px] absolute top-0 left-0 z-0">
          <motion.div
            animate={{
              x: [0, "30vw"],
              top: 340,
              opacity: [0.7, 0.5],
            }}
            transition={{
              duration: 6,
              repeat: Infinity,
              repeatType: "reverse",
              ease: "linear",
            }}
            className="absolute opacity-70 top-[340px] -left-[200px] z-[9]
            w-full max-w-[1800px] h-[100px] bg-gradient-to-l from-transparent via-white/90 to-white"
            style={{
              borderRadius: "100%",
              mixBlendMode: "plus-lighter",
              filter: "blur(50px)",
            }}
          />
          <motion.div
            initial={{
              right: -200,
              top: 150,
              opacity: 0.25,
            }}
            animate={{
              right: [-200, 400],
              opacity: [0.25, 0.1, 0.25],
            }}
            transition={{
              duration: 6,
              repeat: Infinity,
              repeatType: "reverse",
              ease: "linear",
            }}
            className="absolute mix-blend-plus-lighter z-[9] w-full max-w-[800px] h-[200px]
            blur-[60px] rounded-full bg-gradient-to-r from-transparent via-white to-white"
          />

          <LeftBlueHue />

          {/** Clouds - Exactly matching HomePage */}
          <motion.img
            style={{
              mixBlendMode: "plus-lighter",
            }}
            initial={{
              right: 100,
              top: 50,
              rotate: 180,
            }}
            animate={{
              x: "-100vw",
            }}
            transition={{
              duration: 500,
              repeat: Infinity,
              repeatType: "reverse",
              ease: "linear",
            }}
            className="absolute w-full max-w-[500px] z-[5] select-none"
            src="/illustrations/bottomcloud.webp"
            alt="bottomcloudthree"
          />
          <motion.img
            style={{
              mixBlendMode: "plus-lighter",
            }}
            animate={{
              x: [0, "100vw"],
            }}
            transition={{
              duration: 300,
              repeat: Infinity,
              repeatType: "reverse",
            }}
            className="absolute
            top-[180px] w-full max-w-[280px] z-[4] right-[60px] md:right-[600px] select-none"
            src="/illustrations/smallcloudthree.webp"
            alt="smallcloudfour"
          />
          <motion.img
            style={{
              mixBlendMode: "screen",
            }}
            animate={{
              x: [0, "100vw"],
            }}
            transition={{
              duration: 100,
              repeat: Infinity,
              repeatType: "reverse",
              ease: "linear",
            }}
            className="absolute top-[20px] left-[-60px] md:left-[-400px] select-none z-[5] pointer-events-none"
            src="/illustrations/bottomcloud.webp"
            alt="bottomcloudthree"
          />
          <img
            className="absolute
            top-[180px] w-full max-w-[400px] z-0 select-none right-[60px] opacity-30 pointer-events-none"
            src="/illustrations/smallcloudthree.webp"
            alt="smallcloudthree"
          />
          <motion.img
            style={{
              mixBlendMode: "screen",
            }}
            animate={{
              x: [0, "-100vw"],
            }}
            transition={{
              duration: 120,
              repeat: Infinity,
              repeatType: "reverse",
              ease: "linear",
            }}
            className="absolute
            bottom-[240px] w-full max-w-[430px] z-[1] right-[40px] select-none opacity-80 brightness-125 pointer-events-none"
            src="/illustrations/smallcloudtwo.webp"
            alt="smallcloudtwo"
          />
          <img
            style={{
              mixBlendMode: "screen",
            }}
            className="absolute
            w-full max-w-[500px] top-[210px] right-[300px] z-[2] select-none brightness-125 pointer-events-none"
            src="/illustrations/chipcloud.webp"
            alt="chipcloudtwo"
          />
          <motion.img
            style={{
              mixBlendMode: "screen",
            }}
            initial={{
              x: -200,
              rotate: 180,
            }}
            animate={{
              x: [-200, "100vw"],
            }}
            transition={{
              duration: 200,
              repeat: Infinity,
              repeatType: "reverse",
              ease: "linear",
            }}
            className="absolute
            w-full max-w-[500px] bottom-[15px] select-none left-[-200px] lg:left-[30px] z-[10] pointer-events-none"
            src="/illustrations/chipcloud.webp"
            alt="chipcloudfour"
          />
          <img
            className="absolute
            w-full max-w-[500px] top-[160px] select-none mix-blend-screen left-[-200px] lg:left-[30px] z-[10] pointer-events-none"
            src="/illustrations/chipcloud.webp"
            alt="chipcloud"
          />
          <img
            className="absolute bottom-[-200px] -left-[500px] select-none z-[5] pointer-events-none"
            src="/illustrations/bottomcloud.webp"
            alt="bottomcloud"
          />
          <img
            className="absolute bottom-[-90px] right-[-400px] select-none z-[5] pointer-events-none"
            src="/illustrations/bottomcloud.webp"
            alt="bottomcloudtwo"
          />
        </div>

        {/** Right Blue Hue */}
        <div
          className="w-[868px] h-[502px] bg-gradient-to-l rounded-full blur-[100px]
          absolute top-20 z-[0] right-0 from-[#A6D7FF] to-transparent"
        />
      </div>
      <div className="wrapper mx-auto">
        <div className="grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-3 px-12">
           {toolCategories.map((category) => (
            <Link
              key={category.href}
              href={category.href}
              className="group block p-8 border border-gray-200 bg-gray-1 rounded-xl hover:border-blue-500 hover:shadow-md transition-all"
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
        className="mx-auto wrapper mt-16 mb-8 rounded-3xl overflow-hidden relative flex flex-col justify-center p-12"
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
          <div className=" mx-auto h-full flex flex-col justify-center items-center relative z-10">
            <div className="text-center max-w-[800px] mx-auto mb-8">
              <h2 className="text-3xl md:text-4xl font-medium text-white mb-4 drop-shadow-md">
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
      
    </>

  );
}
