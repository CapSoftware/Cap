"use client";

import { ReadyToGetStarted } from "@/components/ReadyToGetStarted";
import { Testimonials } from "@/components/ui/Testimonials";
import {
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
import { useDetectPlatform } from "hooks/useDetectPlatform";
import Link from "next/link";
import React, { useState } from "react";
import { Parallax, ParallaxProvider } from "react-scroll-parallax";
import { LogoSection } from "../_components/LogoSection";
import { FeatureCard } from "../SelfHostingPage";
import LeftBlueHue from "./LeftBlueHue";
import PowerfulFeaturesSVG from "./PowerfulFeaturesSVG";

interface HomePageProps {
  serverHomepageCopyVariant?: string;
}

export const HomePage: React.FC<HomePageProps> = ({
  serverHomepageCopyVariant = "",
}) => {
  const [videoToggled, setVideoToggled] = useState(false);
  const { platform, isIntel } = useDetectPlatform();
  const loading = platform === null;

  return (
    <ParallaxProvider>
      <div className="mt-[120px]">
        <div className="relative z-10 px-5 w-full">
          <div className="mx-auto text-center wrapper wrapper-sm">
            <Link
              href="https://x.com/richiemcilroy/status/1895526857807733018"
              target="_blank"
              className="flex gap-3 transition-colors duration-300 shadow-sm
                 mb-[52px] items-center relative z-[20] px-3.5 py-1
               mx-auto bg-gray-1 rounded-full border w-fit border-gray-5 hover:bg-gray-3"
            >
              <p className="text-[13px] text-gray-12">
                Launch Week Day 5:{" "}
                <span className="text-[13px] font-bold text-blue-9">
                  Self-host Cap
                </span>
              </p>
              <FontAwesomeIcon
                fontWeight="light"
                className="w-2 text-gray-12"
                icon={faAngleRight}
              />
            </Link>
            <h3 className="relative z-10 text-base text-black fade-in-down">
              Record. Edit. Share.
            </h3>
            <h1 className="fade-in-down text-[2rem] font-bold leading-[2.5rem] md:text-[3.75rem] md:leading-[4rem] relative z-10 text-black mb-4">
              {serverHomepageCopyVariant === "1" ? (
                <>
                  Beautiful screen recordings,
                  <br />
                  owned by you.
                </>
              ) : serverHomepageCopyVariant === "2" ? (
                <>The open source Loom alternative.</>
              ) : serverHomepageCopyVariant === "3" ? (
                <>The open source screen recording suite.</>
              ) : (
                <>
                  Beautiful screen recordings,
                  <br />
                  owned by you.
                </>
              )}
            </h1>
            <p className="mx-auto mb-8 max-w-3xl text-md sm:text-xl text-zinc-500 fade-in-down animate-delay-1">
              {serverHomepageCopyVariant === "1" ? (
                <>
                  Cap is the open source alternative to Loom. Lightweight,
                  powerful, and cross-platform. Record and share securely in
                  seconds with custom S3 bucket support.
                </>
              ) : serverHomepageCopyVariant === "2" ? (
                <>
                  Cap is the open source alternative to Loom. Lightweight,
                  powerful, and cross-platform. Record and share securely in
                  seconds. Connect your own storage, domain & more.
                </>
              ) : serverHomepageCopyVariant === "3" ? (
                <>
                  Cap is open source, lightweight, powerful & cross-platform.
                  With Instant Mode for shareable links and Studio Mode for
                  high-quality recordings with local editing.
                </>
              ) : (
                <>
                  Cap is the open source alternative to Loom. Lightweight,
                  powerful, and cross-platform. Record and share securely in
                  seconds with custom S3 bucket support.
                </>
              )}
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

          <PlatformIcons />

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
      <div className="pb-32 wrapper" id="features">
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-12">
            <div className="md:col-span-5">
              <FeatureCard
                title="Privacy-first"
                description="Own your content with Cap's privacy-focused approach. Keep your sensitive information secure and maintain complete control over who can access your recordings - perfect for confidential client communications and internal team sharing."
                imagePath="/illustrations/privacy.webp"
                imageAlt="Complete Control"
                imageHeight="h-[280px]"
              />
            </div>
            <div className="md:col-span-7">
              <FeatureCard
                title="Multi-Platform Support"
                description="Cap works seamlessly across macOS and Windows, giving you the flexibility to create content on any device. Capture, share, and collaborate regardless of which platform you or your team prefers, ensuring smooth workflows and consistent experience everywhere."
                imagePath="/illustrations/multiplatmain.png"
                bg="/illustrations/multiplatbg.webp"
                imageAlt="Enterprise-Ready"
                className="bg-[center_top_-90px] bg-no-repeat bg-cover lg:bg-[center_top_-60px]"
                imageHeight="h-[280px]"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-12">
            <div className="md:col-span-8">
              <FeatureCard
                title="Flexible Storage Options"
                bg="/illustrations/multiplatbg.webp"
                description="Choose how and where you store your recordings. Cap offers both local and cloud storage options to suit your needs. Save space on your device or keep your entire content library accessible from anywhere - ideal for freelancers and growing teams with varied content creation needs."
                imagePath="/illustrations/cloud-feature.webp"
                imageAlt="White Labeling"
                imageHeight="h-[215px]"
                className="lg:bg-[center_top_-150px] bg-[center_top_-120px] bg-no-repeat bg-cover"
              />
            </div>
            <div className="md:col-span-4">
              <FeatureCard
                title="High-Quality Video Capture"
                description="Deliver crystal-clear recordings that showcase your professionalism. Cap ensures exceptional quality for client presentations, tutorials, and team communications - making your content stand out whether you're a solo creator or a small business owner."
                imagePath="/illustrations/video-capture.webp"
                imageAlt="Data Sovereignty"
                imageHeight="h-[224px]"
              />
            </div>
          </div>

          <div className="grid grid-cols-1">
            <FeatureCard
              title="Seamless Team Collaboration"
              description="Share knowledge effortlessly with your team or clients. Cap's intuitive sharing features make it easy to organize content, provide access to specific people, and track engagement. Perfect for small businesses and growing teams who need simple yet powerful collaboration tools."
              imagePath="/illustrations/collaboration.webp"
              imageAlt="Dedicated Support"
              imageHeight="h-[285px]"
            />
          </div>
        </div>
      </div>
      <div className="mb-32 wrapper">
        <Testimonials
          amount={10}
          title="What our users say about Cap after hitting record"
          subtitle="Don't just take our word for it. Here's what our users are saying about their experience with Cap."
        />
      </div>
      <div className="px-5 mb-32">
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
        className="w-[calc(100%-20px)] max-w-[1000px] bg-gray-1 rounded-[16px] md:h-[700px] h-[300px]"
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
