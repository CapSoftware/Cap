import { Button } from "@cap/ui-solid";
import { commands } from "~/utils/tauri";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { createSignal, onMount, onCleanup } from "solid-js";
import { createStore } from "solid-js/store";
import { makePersisted } from "@solid-primitives/storage";
import { generalSettingsStore } from "~/store";
import { cx } from "cva";

import cloud1 from "../assets/illustrations/cloud-1.png";
import cloud2 from "../assets/illustrations/cloud-2.png";
import cloud3 from "../assets/illustrations/cloud-3.png";

import startupAudio from "../assets/tears-and-fireflies-adi-goldstein.mp3";

export default function Startup() {
  const [audioState, setAudioState] = makePersisted(
    createStore({ isMuted: false }),
    { name: "audioSettings" }
  );

  const [isExiting, setIsExiting] = createSignal(false);

  const audio = new Audio(startupAudio);
  audio.play();

  // Add refs to store animation objects
  let cloud1Animation: Animation | undefined;
  let cloud2Animation: Animation | undefined;
  let cloud3Animation: Animation | undefined;

  const [isLogoAnimating, setIsLogoAnimating] = createSignal(false);

  const handleLogoClick = () => {
    if (!isLogoAnimating()) {
      setIsLogoAnimating(true);
      setTimeout(() => setIsLogoAnimating(false), 1000);
    }
  };

  const handleGetStarted = async () => {
    setIsExiting(true);
    const currentWindow = getCurrentWindow();

    // Cancel ongoing cloud animations
    cloud1Animation?.cancel();
    cloud2Animation?.cancel();
    cloud3Animation?.cancel();

    await generalSettingsStore.set({
      hasCompletedStartup: true,
    });

    // Wait for animation to complete before showing new window and closing
    setTimeout(async () => {
      await commands.showAppPermissionsWindow();
      await currentWindow.close();
    }, 600);
  };

  onMount(() => {
    const cloud1El = document.getElementById("cloud-1");
    const cloud2El = document.getElementById("cloud-2");
    const cloud3El = document.getElementById("cloud-3");

    // Top right cloud - gentle diagonal movement
    cloud1Animation = cloud1El?.animate(
      [
        { transform: "translate(0, 0)" },
        { transform: "translate(-20px, 10px)" },
        { transform: "translate(0, 0)" },
      ],
      {
        duration: 30000,
        iterations: Infinity,
        easing: "linear",
      }
    );

    // Top left cloud - gentle diagonal movement
    cloud2Animation = cloud2El?.animate(
      [
        { transform: "translate(0, 0)" },
        { transform: "translate(20px, 10px)" },
        { transform: "translate(0, 0)" },
      ],
      {
        duration: 35000,
        iterations: Infinity,
        easing: "linear",
      }
    );

    // Bottom cloud - slow rise up with subtle horizontal movement
    cloud3Animation = cloud3El?.animate(
      [
        { transform: "translate(-50%, 20px)" },
        { transform: "translate(-48%, 0)" },
        { transform: "translate(-50%, 0)" },
      ],
      {
        duration: 60000,
        iterations: 1,
        easing: "cubic-bezier(0.4, 0, 0.2, 1)",
        fill: "forwards",
      }
    );
  });

  const toggleMute = async () => {
    setAudioState("isMuted", (m) => !m);

    audio.muted = audioState.isMuted;
  };

  return (
    <>
      <style>
        {`
          body {
            background: transparent !important;
          }

          .content-container {
            transition: all 600ms cubic-bezier(0.4, 0, 0.2, 1);
          }

          .content-container.exiting {
            opacity: 0;
            transform: scale(1.1);
          }

          .custom-bg {
            transition: all 600ms cubic-bezier(0.4, 0, 0.2, 1);
          }

          .custom-bg.exiting {
            filter: brightness(1.5); /* Fade the background to white */
          }

          .cloud-1.exiting {
            transform: translate(-200px, -150px) !important;
            opacity: 0 !important;
          }

          .cloud-2.exiting {
            transform: translate(200px, -150px) !important;
            opacity: 0 !important;
          }

          .cloud-3.exiting {
            transform: translate(-50%, 200px) !important;
            opacity: 0 !important;
          }

          .cloud-transition {
            transition: transform 600ms cubic-bezier(0.4, 0, 0.2, 1),
                        opacity 600ms cubic-bezier(0.4, 0, 0.2, 1) !important;
          }

          .cloud-image {
            max-width: 100vw;
            height: auto;
          }

          .grain {
            position: fixed;
            top: -150%;
            left: -50%;
            right: -50%;
            bottom: -150%;
            width: 200%;
            height: 400%;
            background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 512 512' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='1.5' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)'/%3E%3C/svg%3E");
            pointer-events: none;
            opacity: 0.5;
            z-index: 200;
            mix-blend-mode: overlay;
          }

          /* Overlay for fade to black */
          .fade-overlay {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: black;
            opacity: 0;
            pointer-events: none;
            transition: opacity 600ms cubic-bezier(0.4, 0, 0.2, 1);
            z-index: 1000;
          }

          .fade-overlay.exiting {
            opacity: 1;
          }

          @keyframes bounce {
            0%, 100% {
              transform: translateY(0);
            }
            50% {
              transform: translateY(-20px);
            }
          }

          .logo-bounce {
            animation: bounce 1s cubic-bezier(0.36, 0, 0.66, -0.56) forwards;
          }
        `}
      </style>

      {/* Add the fade overlay */}
      <div class={`fade-overlay ${isExiting() ? "exiting" : ""}`} />

      <div
        class={cx(
          "flex flex-col h-screen custom-bg relative overflow-hidden",
          isExiting() && "exiting"
        )}
      >
        {/* Add grain overlay */}
        <div class="grain" />

        {/* Audio control button */}
        <button
          onClick={toggleMute}
          class={`absolute top-5 right-5 z-20 text-gray-50 hover:text-gray-200 transition-colors ${
            isExiting() ? "opacity-0" : ""
          }`}
        >
          {audioState.isMuted ? (
            <IconLucideVolumeX class="w-7 h-7" />
          ) : (
            <IconLucideVolume2 class="w-7 h-7" />
          )}
        </button>

        {/* Floating clouds */}
        <div
          id="cloud-1"
          class={`absolute top-0 right-0 opacity-70 pointer-events-none cloud-transition cloud-1 ${
            isExiting() ? "exiting" : ""
          }`}
        >
          <img
            class="cloud-image w-[100vw] md:w-[80vw] -mr-40"
            src={cloud1}
            alt="Cloud One"
          />
        </div>
        <div
          id="cloud-2"
          class={`absolute top-0 left-0 opacity-70 pointer-events-none cloud-transition cloud-2 ${
            isExiting() ? "exiting" : ""
          }`}
        >
          <img
            class="cloud-image w-[100vw] md:w-[80vw] -ml-40"
            src={cloud2}
            alt="Cloud Two"
          />
        </div>
        <div
          id="cloud-3"
          class={`absolute -bottom-[15%] left-1/2 -translate-x-1/2 opacity-70 pointer-events-none cloud-transition cloud-3 ${
            isExiting() ? "exiting" : ""
          }`}
        >
          <img
            class="cloud-image w-[180vw] md:w-[180vw]"
            src={cloud3}
            alt="Cloud Three"
          />
        </div>

        {/* Main content */}
        <div
          class={`content-container flex flex-col items-center justify-center flex-1 relative z-10 px-4 ${
            isExiting() ? "exiting" : ""
          }`}
        >
          <div class="text-center mb-8">
            <div onClick={handleLogoClick} class="cursor-pointer inline-block">
              <IconCapLogo
                class={`w-20 h-24 mx-auto drop-shadow-[0_0_100px_rgba(0,0,0,0.2)]
                  ${isLogoAnimating() ? "logo-bounce" : ""}`}
              />
            </div>
            <h1 class="text-5xl md:text-5xl font-bold font-medium text-gray-50 mb-4 drop-shadow-[0_0_20px_rgba(0,0,0,0.2)]">
              Welcome to Cap
            </h1>
            <p class="text-2xl text-gray-50/70 max-w-md mx-auto drop-shadow-[0_0_20px_rgba(0,0,0,0.2)]">
              Beautiful, shareable screen recordings.
            </p>
          </div>

          <Button
            class="px-12 text-lg shadow-[0_0_30px_rgba(0,0,0,0.1)]"
            variant="secondary"
            size="lg"
            onClick={handleGetStarted}
          >
            Get Started
          </Button>
        </div>
      </div>
    </>
  );
}
