// million-ignore

"use client";

import { ReadyToGetStarted } from "@/components/ReadyToGetStarted";
import {
  detectPlatform,
  getDownloadButtonText,
  getDownloadUrl,
  getPlatformIcon,
  PlatformIcons,
} from "@/utils/platform";
import { Button } from "@cap/ui";
import { faAngleRight, faPlay } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import MuxPlayer from "@mux/mux-player-react";
import { useClickAway } from "@uidotdev/usehooks";
import { AnimatePresence, motion } from "framer-motion";
import Link from "next/link";
import React, { useEffect, useState } from "react";
import { Parallax, ParallaxProvider } from "react-scroll-parallax";
import { LogoSection } from "../_components/LogoSection";
import LeftBlueHue from "./LeftBlueHue";
import PowerfulFeaturesSVG from "./PowerfulFeaturesSVG";
import { FeatureCard } from "../SelfHostingPage";
export const HomePage = () => {
  const [videoToggled, setVideoToggled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [platform, setPlatform] = useState<string | null>(null);
  const [isIntel, setIsIntel] = useState(false);

  useEffect(() => {
    const detectUserPlatform = async () => {
      try {
        const { platform, isIntel } = await detectPlatform();
        setPlatform(platform);
        setIsIntel(isIntel);
      } catch (error) {
        console.error("Error detecting platform:", error);
      } finally {
        setLoading(false);
      }
    };

    detectUserPlatform();
  }, []);

  return (
    <ParallaxProvider>
      <div className="mt-[120px]">
        <div className="relative z-10 px-5 w-full">
          <div className="mx-auto text-center wrapper wrapper-sm">
            <Link
              href="https://x.com/richiemcilroy/status/1895526857807733018"
              target="_blank"
              className="flex gap-3 transition-opacity duration-300
                 hover:opacity-90 mb-[52px] items-center relative z-[20] px-4 py-2
               mx-auto bg-[#2e2e2e] rounded-full border w-fit border-zinc-200"
            >
              <p className="text-xs text-white sm:text-sm">
                Launch Week Day 5:{" "}
                <span className="text-xs font-bold text-blue-100 sm:text-sm">
                  Self-host Cap
                </span>
              </p>
              <FontAwesomeIcon
                fontWeight="light"
                className="w-2 text-white"
                icon={faAngleRight}
              />
            </Link>
            <h3 className="relative z-10 text-base text-black fade-in-down">
              Record. Edit. Share.
            </h3>
            <h1 className="fade-in-down text-[2rem] font-bold leading-[2.5rem] md:text-[3.75rem] md:leading-[4rem] relative z-10 text-black mb-4">
              Beautiful screen recordings,
              <br />
              owned by you.
            </h1>
            <p className="mx-auto mb-8 max-w-3xl text-md sm:text-xl text-zinc-500 fade-in-down animate-delay-1">
              Cap is the open source alternative to Loom. Lightweight, powerful,
              and cross-platform. Record and share securely in seconds with
              custom S3 bucket support.
            </p>
          </div>
          <div className="flex flex-col justify-center items-center mb-5 space-y-2 fade-in-up animate-delay-2 sm:flex-row sm:space-y-0 sm:space-x-2">
            <Button
              variant="white"
              href={
                platform === "windows"
                  ? "/download"
                  : getDownloadUrl(platform, isIntel)
              }
              size="lg"
              className="flex justify-center items-center w-full font-medium text-md sm:w-auto"
            >
              {!loading && getPlatformIcon(platform)}
              {getDownloadButtonText(platform, loading, isIntel)}
            </Button>
            <Button
              variant="radialblue"
              href="/pricing"
              size="lg"
              className="relative z-[20] w-full font-medium text-md sm:w-auto"
            >
              Buy Now
            </Button>
          </div>
          <p className="text-sm text-center text-zinc-400 animate-delay-2 fade-in-up">
            Free version available. No credit card required.
          </p>

          {/* Platform icons */}
          <PlatformIcons />

          {/* See other options button */}
          <div className="flex justify-center mt-2">
            <Link
              href="/download"
              className="text-sm text-center underline text-zinc-400 animate-delay-2 fade-in-up hover:text-zinc-500"
            >
              See other options
            </Link>
          </div>
        </div>
        <AnimatePresence>
          {videoToggled && <VideoModal setVideoToggled={setVideoToggled} />}
        </AnimatePresence>
        <Parallax
          className="relative flex items-center justify-center w-full max-w-[540px] mx-auto mt-[100px] mb-[190px] sm:mt-[160px] sm:mb-[200px]"
          scale={[1, 1.6]}
        >
          <motion.div
            whileTap={{ scale: 0.95 }}
            whileHover={{ scale: 1.05 }}
            onClick={() => setVideoToggled(true)}
            className="absolute cursor-pointer size-[100px] flex items-center justify-center group"
          >
            <div
              style={{
                background:
                  "linear-gradient(180deg, rgba(255, 255, 255, 0.10) 30%, #3B7BFA 100%)",
                boxShadow: "0px 0px 40px 16px rgba(25, 39, 67, 0.25)",
              }}
              className="size-[100px] relative backdrop-blur-[6px] rounded-full flex items-center justify-center play-button-outer-border"
            >
              <div
                className="size-[80px] flex items-center justify-center relative inner-play-button-border-two group-hover:brightness-110 transition-all duration-300 backdrop-blur-[6px] rounded-[80px]"
                style={{
                  background:
                    "linear-gradient(180deg, #90BDFF 0%, #3588FF 100%)",
                  boxShadow:
                    "0px 2px 0px 0px #C5DDFF inset, 0px 12px 6.3px -2px #A5CAFF inset, 0px -7px 9.2px 0px #305098 inset, 0px 14px 20px -8px #0E275E, 0px -19px 24px 0px #2363BF inset",
                }}
              >
                <FontAwesomeIcon
                  className="text-white size-5 drop-shadow-[0px_0px_5px_rgba(255,255,255)]"
                  icon={faPlay}
                />
              </div>
            </div>
          </motion.div>
          <img
            src="/illustrations/app.webp"
            className="mx-auto w-full max-w-[540px] pointer-events-none h-auto rounded-xl"
            alt="Landing Page Screenshot Banner"
          />
        </Parallax>
        {/** Header BG */}
        <div className="w-full mx-auto overflow-hidden h-[830px] absolute top-0 left-0">
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
          {/** Clouds */}
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
            src="./illustrations/bottomcloud.webp"
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
            src="./illustrations/smallcloudthree.webp"
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
            src="./illustrations/bottomcloud.webp"
            alt="bottomcloudthree"
          />
          <img
            className="absolute
            top-[180px] w-full max-w-[400px] z-0 select-none right-[60px] opacity-30 pointer-events-none"
            src="./illustrations/smallcloudthree.webp"
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
        bottom-[240px] w-full max-w-[430px] z-[1] right-[40px] select-none  opacity-80 brightness-125 pointer-events-none"
            src="./illustrations/smallcloudtwo.webp"
            alt="smallcloudtwo"
          />
          <img
            style={{
              mixBlendMode: "screen",
            }}
            className="absolute
         w-full max-w-[500px] top-[210px] right-[300px] z-[2] select-none  brightness-125 pointer-events-none"
            src="./illustrations/chipcloud.webp"
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
            src="./illustrations/chipcloud.webp"
            alt="chipcloudfour"
          />
          <img
            className="absolute
         w-full max-w-[500px] top-[160px] select-none mix-blend-screen left-[-200px] lg:left-[30px] z-[10] pointer-events-none"
            src="./illustrations/chipcloud.webp"
            alt="chipcloud"
          />
          <img
            className="absolute bottom-[-200px] -left-[500px] select-none z-[5] pointer-events-none"
            src="./illustrations/bottomcloud.webp"
            alt="bottomcloud"
          />
          <img
            className="absolute bottom-[-90px] right-[-400px] select-none z-[5] pointer-events-none"
            src="./illustrations/bottomcloud.webp"
            alt="bottomcloudtwo"
          />
        </div>
        {/** Right Blue Hue */}
        <div
          className="w-[868px] h-[502px] bg-gradient-to-l rounded-full blur-[100px]
      absolute top-20 z-[0] right-0 from-[#A6D7FF] to-transparent"
        />
      </div>
      <LogoSection />
      <div className="pb-32 wrapper md:pb-40">
        <div className="mb-4">
          <PowerfulFeaturesSVG />
        </div>
        <div className="text-center max-w-[800px] mx-auto mb-8">
          <h2 className="mb-3">Crafted for simplicity</h2>
          <p className="text-[1.125rem] leading-[1.75rem]">
            We believe great tools should make your life easier, not more
            complicated. Cap is crafted to streamline your workflow, so you can
            record, edit, and share without jumping through hoops.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <div className="overflow-hidden rounded-[20px]">
            <img
              className="w-full h-auto max-h-[290px] object-cover"
              src="/features/ease-of-use.png"
              alt="Ease of use Illustration"
            />
          </div>
          <div className="overflow-hidden rounded-[20px]">
            <img
              className="w-full h-auto max-h-[290px] object-cover"
              src="/features/privacy-first.png"
              alt="Privacy first Illustration"
            />
          </div>
          <div className="overflow-hidden rounded-[20px]">
            <img
              className="w-full h-auto max-h-[290px] object-cover"
              src="/features/lightweight.png"
              alt="Lightweight Illustration"
            />
          </div>
          <div className="overflow-hidden rounded-[20px]">
            <img
              className="w-full h-auto max-h-[290px] object-cover"
              src="/features/open-source.png"
              alt="Open source Illustration"
            />
          </div>
        </div>
      </div>
      <div className="pb-32 wrapper md:pb-40" id="features">
        <div className="space-y-3">
          {/* Section 1: 35% / 65% split */}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-12">
            <div className="md:col-span-5">
              <FeatureCard
                title="Privacy-first"
                description="Host Cap on your own servers with complete data sovereignty. Maintain full control over your sensitive information and ensure compliance with your organization's security policies and regulatory requirements."
                imagePath="/illustrations/privacy.webp"
                imageAlt="Complete Control"
                imageHeight="h-[280px]"
              />
            </div>
            <div className="md:col-span-7">
              <FeatureCard
                title="Multi-Platform Support"
                description="Self-hosted Cap works seamlessly across macOS and Windows, giving your team the flexibility to collaborate regardless of their device preference. Deploy once and enable your entire organization to capture, share, and collaborate from any device."
                imagePath="/illustrations/multiplatmain.png"
                bg="/illustrations/multiplatbg.webp"
                imageAlt="Enterprise-Ready"
                className="bg-[center_top_-90px] bg-no-repeat bg-cover lg:bg-[center_top_-60px]"
                imageHeight="h-[280px]"
              />
            </div>
          </div>

          {/* Section 2: 65% / 35% split */}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-12">
            <div className="md:col-span-8">
              <FeatureCard
                title="Unlimited Recording and Cloud Storage"
                bg="/illustrations/multiplatbg.webp"
                description="Configure storage limits based on your infrastructure capacity. Self-hosting eliminates cloud storage fees and gives you complete control over retention policies, ideal for teams with high-volume recording needs or long-term archival requirements."
                imagePath="/illustrations/cloud-feature.webp"
                imageAlt="White Labeling"
                imageHeight="h-[215px]"
                className="lg:bg-[center_top_-150px] bg-[center_top_-120px] bg-no-repeat bg-cover"
              />
            </div>
            <div className="md:col-span-4">
              <FeatureCard
                title="High-Quality Video Capture"
                description="Deliver crystal-clear recordings to your team with self-hosted infrastructure optimized for your network. Eliminate quality degradation from third-party services and ensure consistent performance across your organization."
                imagePath="/illustrations/video-capture.webp"
                imageAlt="Data Sovereignty"
                imageHeight="h-[224px]"
              />
            </div>
          </div>

          {/* Section 3: Full width */}
          <div className="grid grid-cols-1">
            <FeatureCard
              title="Advanced Team Collaboration"
              description="Enable seamless knowledge sharing across departments with customizable access controls and team workspaces. Self-hosted Cap provides enterprise-grade collaboration features that integrate with your existing authentication systems and team structure."
              imagePath="/illustrations/collaboration.webp"
              imageAlt="Dedicated Support"
              imageHeight="h-[285px]"
            />
          </div>
        </div>
      </div>
      <div className="px-5 mb-32 md:mb-40">
        <ReadyToGetStarted />
      </div>
    </ParallaxProvider>
  );
};

interface Props {
  setVideoToggled: React.Dispatch<React.SetStateAction<boolean>>;
}

const VideoModal = ({ setVideoToggled }: Props) => {
  const ref = useClickAway<HTMLDivElement>(() => setVideoToggled(false));
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="flex fixed inset-0 justify-center items-center w-screen z-[500] h-screen backdrop-blur-md bg-black/20"
    >
      <motion.div
        initial={{ filter: "blur(20px)", y: 50 }}
        animate={{ filter: "blur(0px)", y: 0 }}
        exit={{ filter: "blur(20px)", y: 50 }}
        transition={{
          type: "spring",
          bounce: 0.3,
          stiffness: 250,
          damping: 20,
        }}
        ref={ref}
        className="w-[calc(100%-20px)] max-w-[1000px] bg-white rounded-[16px] md:h-[700px] h-[300px]"
      >
        <MuxPlayer
          playbackId="A6oZoUWVZjOIVZB6XnBMLagYnXE6xhDhp8Hcyky018hk"
          metadataVideoTitle="Placeholder (optional)"
          metadata-viewer-user-id="Placeholder (optional)"
          accentColor="#5C9FFF"
          className="h-full rounded-[16px] overflow-hidden select-none"
          autoPlay
        />
      </motion.div>
    </motion.div>
  );
};
