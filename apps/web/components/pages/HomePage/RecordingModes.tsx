import { getDownloadButtonText, getDownloadUrl, getPlatformIcon } from "@/utils/platform";
import { Button } from "@cap/ui";
import clsx from "clsx";
import { motion } from "framer-motion";
import { useDetectPlatform } from "hooks/useDetectPlatform";
import { Clapperboard, Zap } from "lucide-react";
import { useState } from "react";

interface Mode {
    name: "Instant" | "Studio";
    icon: JSX.Element;
    description: string;
}

const modes: Mode[] = [
    {
        name: "Instant",
        icon: <Zap fill="yellow" className="size-5 md:size-6" strokeWidth={1.5} />,
        description: "Share your screen instantly with a magic link — no waiting for rendering, just capture and share in seconds."
    },
    {
        name: "Studio",
        icon: <Clapperboard fill="var(--blue-9)" className="size-5 md:size-6" strokeWidth={1.5} />,
        description: "Experience the power of Cap Studio Mode for high-quality recordings with local editing."
    }
];

const RecordingModes = () => {
    const [activeMode, setActiveMode] = useState<Mode | undefined>(modes[0]);
    const { platform, isIntel } = useDetectPlatform();
    const loading = platform === null;
    
    return (
        <div className="w-full max-w-[1200px] mx-auto px-5">
          <div className="flex flex-col gap-2 justify-center items-center text-center">
          <h1 className="text-4xl font-medium text-12">Instant & Studio modes</h1>
          <p className="text-lg text-gray-10">Upload your videos instantly or experience our editor before sharing</p>
          </div>
          {/*Toggles*/}
            <div className="flex flex-1 gap-5 mt-[52px]">
                {modes.map((mode) => (
                    <div onClick={() => setActiveMode(mode)} key={mode.name} className={clsx("flex overflow-hidden relative",
                        "flex-1 gap-3 justify-center items-center px-6 py-4 text-lg md:text-2xl font-medium rounded-2xl border transition-colors duration-200" ,
                        "cursor-pointer text-gray-12 bg-gray-1 border-gray-5", activeMode !== mode ? "hover:bg-gray-3" : "pointer-events-none")}>
                        <div className="flex gap-1.5 z-[2] items-center">
                        {mode.icon}
                        {mode.name}
                        </div>
                        {activeMode?.name === mode.name && (
                            <motion.div
                                initial={{ width: "0%", borderRadius: 0 }}
                               animate={{
                                width: "100%",
                               }}
                               exit={{ width: "0%" }}
                               onAnimationComplete={() => setActiveMode(prev => prev === modes[0] ? modes[1] : modes[0])}
                               transition={{
                                duration: 10,
                                ease: "linear"
                               }}
                            className={clsx("absolute z-[1] inset-0 h-full", activeMode.name === modes[0]?.name ? "bg-yellow-100" : "bg-blue-100")} />
                        )}
                    </div>
                ))}
            </div>
            {/* Video*/}
            <div className="mt-5 w-full rounded-2xl border shadow-xl h-fit bg-gray-1 border-gray-5 shadow-black/5">
                    {/*Video Content*/}
               <div className="relative h-full">
               <img src="/illustrations/videopreview.jpg" alt="App" className="object-cover w-full min-h-[90%] rounded-t-xl" />
               {/*Video Description*/}
               <div className="absolute right-0 bottom-0 left-0 p-4 border-t backdrop-blur-md bg-black/70 border-gray-12">
                <p className="mx-auto w-full text-sm text-center md:text-xl text-gray-1">{activeMode?.description}</p>
               </div>
               </div>
               <div className="p-6">
               <Button
                variant="primary"
                href={
                  platform === "windows"
                    ? "/download"
                    : getDownloadUrl(platform, isIntel)
                }
                size="lg"
                className="flex justify-center items-center mx-auto font-medium w-fit"
              >
                {!loading && getPlatformIcon(platform)}
                {getDownloadButtonText(platform, loading, isIntel)}
              </Button>
               </div>
            </div>
        </div>
    )
}

export default RecordingModes;