// million-ignore
"use client";

import { LogoMarquee } from "@/components/ui/LogoMarquee";
import {
  getDownloadButtonText,
  getDownloadUrl,
  getPlatformIcon,
  PlatformIcons,
} from "@/utils/platform";
import { Button } from "@cap/ui";
import { faAngleRight, faPlay } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { AnimatePresence, motion } from "framer-motion";
import { useDetectPlatform } from "hooks/useDetectPlatform";
import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import VideoModal from "./VideoModal";

interface HeaderProps {
    serverHomepageCopyVariant?: string;
}

    
    // Animation variants
    const fadeIn = {
      hidden: { opacity: 0, y: 20 },
      visible: (custom: number) => ({
          opacity: 1,
          y: 0,
          transition: {
              delay: custom * 0.1,
              duration: 0.5,
              ease: "easeOut"
          }
      })
  };
  
  const fadeInFromRight = {
      hidden: { opacity: 0, x: 50 },
      visible: {
          opacity: 1,
          x: 0,
          transition: {
              delay: 0.5,
              duration: 0.6,
              ease: "easeOut"
          }
      }
  };

const Header = ({ serverHomepageCopyVariant = "" }: HeaderProps) => {
    const [videoToggled, setVideoToggled] = useState(false);
    const { platform, isIntel } = useDetectPlatform();
    const loading = platform === null;
    
    return (
        <div className="mt-[60px] min-h-screen w-full max-w-[1920px] overflow-x-hidden md:overflow-visible mx-auto md:mt-[15vh]">
            <div className="flex flex-col justify-center lg:justify-start xl:flex-row relative z-10 px-5 w-full mb-[200px]">
                <div className="w-full max-w-[500px] 2xl:mt-12 mx-auto xl:ml-[100px] 2xl:ml-[150px]">
                    <motion.div
                        initial="hidden"
                        animate="visible"
                        custom={0}
                        variants={fadeIn}
                    >
                        <Link
                            href="https://x.com/richiemcilroy/status/1895526857807733018"
                            target="_blank"
                            className="flex gap-2 items-center px-3 py-2 mb-8 bg-white rounded-full border group border-gray-4 w-fit"
                        >
                            <p className="font-mono text-xs text-gray-12">
                                Auto zoom has been released
                            </p>
                            <FontAwesomeIcon
                                fontWeight="light"
                                className="w-1.5 text-gray-12 group-hover:translate-x-0.5 transition-transform"
                                icon={faAngleRight}
                            />
                        </Link>
                    </motion.div>

          <div className="flex flex-col text-left w-full max-w-[650px]">
            <motion.h1
              className="text-[2.8rem] font-medium leading-[3rem] md:text-[3.75rem] md:leading-[4rem] relative z-10 text-black mb-4"
              initial="hidden"
              animate="visible"
              custom={1}
              variants={fadeIn}
            >
              {serverHomepageCopyVariant === "1" ? (
                <>Beautiful screen recordings, owned by you.</>
              ) : serverHomepageCopyVariant === "2" ? (
                <>The open source Loom alternative.</>
              ) : serverHomepageCopyVariant === "3" ? (
                <>The open source screen recording suite.</>
              ) : (
                <>Beautiful screen recordings, owned by you.</>
              )}
            </motion.h1>

            <motion.p
              className="mx-auto mb-8 max-w-3xl text-lg text-zinc-500"
              initial="hidden"
              animate="visible"
              custom={2}
              variants={fadeIn}
            >
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
            </motion.p>
          </div>

          <motion.div
            className="flex flex-col items-center mb-5 space-y-2 sm:flex-row sm:space-y-0 sm:space-x-4"
            initial="hidden"
            animate="visible"
            custom={3}
            variants={fadeIn}
          >
            <Button
              variant="white"
              href={
                platform === "windows"
                  ? "/download"
                  : getDownloadUrl(platform, isIntel)
              }
              size="lg"
              className="flex justify-center items-center w-full font-medium sm:w-auto"
            >
              {!loading && getPlatformIcon(platform)}
              {getDownloadButtonText(platform, loading, isIntel)}
            </Button>
            <Button
              variant="primary"
              href="/pricing"
              size="lg"
              className="relative z-[20] w-full font-medium sm:w-auto"
            >
              Buy Now
            </Button>
          </motion.div>

          <motion.p
            className="text-sm text-gray-10"
            initial="hidden"
            animate="visible"
            custom={4}
            variants={fadeIn}
          >
            Free version available. No credit card required.
          </motion.p>

          <motion.div
            className="mt-6 mb-10"
            initial="hidden"
            animate="visible"
            custom={5}
            variants={fadeIn}
          >
            {/* Platform icons */}
            <PlatformIcons />

            {/* See other options button */}
            <Link
              href="/download"
              className="mt-2 text-sm underline text-gray-10 hover:text-gray-12"
            >
              See other options
            </Link>
          </motion.div>

          {/* Logo Marquee */}
          <motion.div
            className="mt-14"
            initial="hidden"
            animate="visible"
            custom={6}
            variants={fadeIn}
          >
            <LogoMarquee />
          </motion.div>
        </div>

        <motion.div
          className="xl:absolute drop-shadow-2xl -top-[15%] lg:-right-[400px] 2xl:-right-[300px] w-full xl:max-w-[1000px] 2xl:max-w-[1200px]"
          initial="hidden"
          animate="visible"
          variants={fadeInFromRight}
        >
          {/* Play Button*/}
          <motion.div
            whileTap={{ scale: 0.95 }}
            whileHover={{ scale: 1.05 }}
            onClick={() => setVideoToggled(true)}
            className="size-[70px] md:size-[100px] inset-x-0 mx-auto top-[35vw] xs:top-[180px] sm:top-[35vw] xl:top-[350px] 2xl:top-[400px] xl:left-[-50px] relative cursor-pointer z-10 
              shadow-[0px_60px_40px_3px_rgba(0,0,0,0.4)] flex items-center justify-center rounded-full bg-blue-500"
          >
            <FontAwesomeIcon icon={faPlay} className="text-white size-4 md:size-6" />
          </motion.div>
          <Image
            src="/illustrations/app.webp"
            width={1000}
            height={1000}
            quality={100}
            alt="App"
            className="object-cover relative inset-0 rounded-xl opacity-70 size-full"
          />
        </motion.div>
      </div>
      <AnimatePresence>
        {videoToggled && <VideoModal setVideoToggled={setVideoToggled} />}
      </AnimatePresence>
        </div>
    );
};

export default Header;
