// million-ignore

"use client";

import { useState, useRef } from "react";
import { Parallax } from "react-scroll-parallax";
import toast from "react-hot-toast";
import { ParallaxProvider } from "react-scroll-parallax";
import { Button } from "@cap/ui";
import Link from "next/link";
import { Newspaper } from "lucide-react";

export const HomePage = () => {
  const [showEmail, setShowEmail] = useState<boolean>(false);
  const [waitlistSuccess, setWaitlistSuccess] = useState<boolean>(false);
  const [waitlistLoading, setWaitlistLoading] = useState<boolean>(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const formData = new FormData(event.currentTarget);
    const email = formData.get("email");

    if (!email) {
      setEmailError("Please enter your email address to receive updates.");
      return;
    }

    setWaitlistLoading(true);
    setEmailError(null);

    const response = await fetch("/api/waitlist", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email }),
    });

    if (response.ok) {
      setWaitlistSuccess(true);
    }

    setWaitlistLoading(false);
  };

  return (
    <ParallaxProvider>
      <div className="w-full custom-bg">
        <div className="wrapper wrapper-sm mx-auto">
          <div className="mb-auto -mt-20 text-center md:px-4 pt-32 pb-52 md:pb-64 space-y-8">
            <h1 className="fade-in-down text-3xl lg:text-6xl relative z-10 text-black">
              Effortless, instant screen sharing.
            </h1>
            <p className="fade-in-down animate-delay-1 text-base sm:text-xl max-w-2xl mx-auto text-black mb-8">
              Cap is the open source alternative to Loom. Lightweight, powerful,
              and stunning. Record and share in seconds.
            </p>
            {waitlistSuccess === true ? (
              <div className="fade-in-up max-w-lg mx-auto styled-links">
                <p className="text-sm text-black">
                  Thank you for joining the waitlist. Development of Cap is
                  ongoing, and you can follow along live either via{" "}
                  <a
                    className="text-black"
                    href="https://x.com/richiemcilroy"
                    target="_blank"
                  >
                    Twitter (X)
                  </a>
                  , our growing{" "}
                  <a
                    className="text-black"
                    href="https://discord.com/invite/y8gdQ3WRN3"
                    target="_blank"
                  >
                    Discord community
                  </a>
                  , or over on the Cap{" "}
                  <a
                    className="text-black"
                    href="https://github.com/CapSoftware/cap"
                    target="_blank"
                  >
                    GitHub repository
                  </a>
                </p>
              </div>
            ) : showEmail === true ? (
              <div className="fade-in-up max-w-sm mx-auto">
                <form
                  onSubmit={handleSubmit}
                  className="h-[38px] relative flex border border-primary rounded-lg overflow-hidden mb-3"
                >
                  <input
                    autoFocus
                    ref={emailRef}
                    type="email"
                    name="email"
                    placeholder="Your email address"
                    className="w-full h-full bg-white focus:outline-none outline-none px-3 text-sm sm:text-base text-black"
                  />
                  <button className="bg-primary-2 hover:bg-primary-3 border border-primary text-white font-medium text-sm sm:text-base py-1.5 px-3 min-w-[100px]">
                    {waitlistLoading === true ? "Loading..." : "Submit"}
                  </button>
                </form>
                {emailError ? (
                  <p className="text-red-600 text-sm">{emailError}</p>
                ) : (
                  <p className="text-gray-600 text-sm">
                    Sign up to receive development updates and early access.
                  </p>
                )}
              </div>
            ) : (
              <div className="fade-in-up animate-delay-2">
                <div className="flex items-center justify-center space-x-2 mb-3">
                  <Button href="/download" size="lg">
                    Get started for free
                  </Button>
                </div>
                <p className="text-gray-500 text-sm">
                  No credit card required.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
      <div id="scrolling-section" className="pb-48 fade-in-up animate-delay-2">
        <Parallax
          className="cursor-pointer"
          scale={[2.2, 1.25]}
          onClick={() =>
            toast("This was going to be something cool... it might be later 👀")
          }
        >
          <img
            src="/landing-banner.jpg"
            className="w-full max-w-[600px] block mx-auto h-auto rounded-xl"
            alt="Landing Page Screenshot Banner"
          />
        </Parallax>
      </div>
    </ParallaxProvider>
  );
};
