"use client";

import { useState, useRef } from "react";
import { LogoBadge } from "ui";
import { Parallax } from "react-scroll-parallax";
import toast from "react-hot-toast";

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
    <>
      <div className="w-full custom-bg">
        <div className="wrapper wrapper-sm mx-auto">
          <div className="mb-auto -mt-20 text-center md:px-4 pt-32 pb-52 md:pt-52 md:pb-64 space-y-8">
            <h1 className="fade-in-down text-3xl sm:text-5xl lg:text-7xl relative z-10 text-black">
              Your screen recordings deserve to be beautiful.
            </h1>
            <p className="fade-in-down animate-delay-1 text-base sm:text-xl max-w-2xl mx-auto text-black">
              Cap is an open source and privacy-focused alternative to Loom.
              Lightweight, powerful, and stunning. Record and share in seconds.
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
                    href="https://github.com/cap-so/cap"
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
                  <button
                    onClick={() => {
                      setShowEmail(true);
                      emailRef.current?.focus();
                    }}
                    className="bg-primary-2 hover:bg-primary-3 border border-primary text-white font-medium text-sm sm:text-base rounded-lg py-1.5 px-3"
                  >
                    Join Waitlist
                  </button>
                  <a
                    href="https://github.com/cap-so/cap"
                    target="_blank"
                    className="bg-gray-700 hover:bg-gray-800 border border-gray-600 flex items-center space-x-2 text-white font-medium text-sm sm:text-base rounded-lg py-1.5 px-3"
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      fill="currentColor"
                      className="w-5 h-5"
                      viewBox="0 0 24 24"
                    >
                      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"></path>
                    </svg>
                    <span className="text-white">Star on GitHub</span>
                  </a>
                </div>
                <p className="text-gray-600 text-sm">
                  Coming soon to macOS, Windows and Linux.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
      <div id="scrolling-section" className="pb-48 fade-in-up animate-delay-2">
        <div className="w-full h-full relative flex items-center -mt-20">
          <div className="w-full flex items-center justify-center">
            <Parallax
              className="cursor-pointer"
              scale={[2, 1]}
              opacity={[0.25, 1]}
              onClick={() =>
                toast(
                  "This was going to be something cool... it might be later 👀"
                )
              }
            >
              <div>
                <LogoBadge className="w-[175px] lg:w-[300px] h-auto max-w-full mx-auto z-10" />
              </div>
            </Parallax>
          </div>
        </div>
      </div>
    </>
  );
};
