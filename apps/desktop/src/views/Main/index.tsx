import type { NextPage } from "next";
import Link from "next/link";
import Image from "next/image";
import { getCookie } from "cookies-next";
import { useEffect, useState } from "react";
import { useRouter } from "next/router";

import { LogoSpinner } from "@cap/ui";
import Page from "../Page";

const Home: NextPage = () => {
  const [isSignedIn, setIsSignedIn] = useState(false);
  const [cameraWindowOpen, setCameraWindowOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  useEffect(() => {
    const checkSignInStatus = async () => {
      const cookie = getCookie("next-auth.session-token");
      const signedIn = !!cookie;

      if (signedIn !== isSignedIn) {
        setIsSignedIn(signedIn);
      }
      if (loading) {
        setLoading(false);
      }
    };

    checkSignInStatus();
    const interval = setInterval(checkSignInStatus, 1000);

    return () => clearInterval(interval);
  }, [isSignedIn, loading]);

  useEffect(() => {
    if (isSignedIn && !cameraWindowOpen) {
      import("@tauri-apps/api/window").then(
        ({ currentMonitor, WebviewWindow }) => {
          setCameraWindowOpen(true);

          currentMonitor().then((monitor) => {
            const windowWidth = 230;
            const windowHeight = 230;

            if (monitor && monitor.size) {
              const scalingFactor = monitor.scaleFactor;
              const x = 100;
              const y =
                monitor.size.height / scalingFactor - windowHeight - 100;

              const existingCameraWindow = WebviewWindow.getByLabel("camera");
              if (existingCameraWindow) {
                console.log("Camera window already open.");
                existingCameraWindow.close();
              } else {
                new WebviewWindow("camera", {
                  url: "/camera",
                  title: "Cap Camera",
                  width: windowWidth,
                  height: windowHeight,
                  x: x / scalingFactor,
                  y: y,
                  maximized: false,
                  resizable: false,
                  fullscreen: false,
                  transparent: true,
                  decorations: false,
                  alwaysOnTop: true,
                  center: false,
                });
              }
            }
          });
        }
      );
    }
  }, [isSignedIn, cameraWindowOpen]);

  const onClick = () => {
    router.push("/signin");
  };

  if (loading) {
    return (
      <Page>
        <div className="w-screen h-screen flex items-center justify-center">
          <LogoSpinner className="w-10 h-auto animate-spin" />
        </div>
      </Page>
    );
  }

  return (
    <Page>
      <section className="bg-gray-50 dark:bg-gray-900">
        <div className="flex flex-col items-center justify-center px-6 py-8 mx-auto md:h-screen lg:py-0">
          <a
            href="/"
            className="flex items-center gap-2 mb-6 text-2xl font-semibold text-gray-900 dark:text-white"
          >
            <Image src="/images/logo.png" height={32} width={32} alt="logo" />
            Cap App
          </a>

          <div className="flex items-center gap-5">
            <Link href="/signin">
              <button
                type="button"
                className="text-white bg-blue-700 hover:bg-blue-800 focus:ring-4 focus:ring-blue-300 font-medium rounded-lg text-sm px-5 py-2.5 me-2 mb-2 dark:bg-blue-600 dark:hover:bg-blue-700 focus:outline-none dark:focus:ring-blue-800"
              >
                Sign In
              </button>
            </Link>

            <Link href="/signin">
              <button
                type="button"
                className="text-white bg-blue-700 hover:bg-blue-800 focus:ring-4 focus:ring-blue-300 font-medium rounded-lg text-sm px-5 py-2.5 me-2 mb-2 dark:bg-blue-600 dark:hover:bg-blue-700 focus:outline-none dark:focus:ring-blue-800"
                onClick={onClick}
              >
                Sign Up
              </button>
            </Link>
          </div>
        </div>
      </section>
    </Page>
  );
};

export default Home;
