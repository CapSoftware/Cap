"use client";

import { Button } from "@cap/ui";
import { useEffect } from "react";
import MuxPlayer from "@mux/mux-player-react";

export const AboutPage = () => {
  const handleSmoothScroll = (
    e: React.MouseEvent<HTMLButtonElement>,
    targetId: string
  ) => {
    e.preventDefault();
    const targetElement = document.getElementById(targetId);
    if (targetElement) {
      window.scrollTo({
        top: targetElement.offsetTop,
        behavior: "smooth",
      });
    }
  };

  return (
    <div className="py-32 wrapper">
      <div className="mb-14 text-center page-intro">
        <div className="flex justify-center mb-8">
          <svg width="180" height="60" viewBox="0 0 180 60" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="30" cy="30" r="28" fill="#8B5CF6"/>
            <text x="70" y="42" fill="currentColor" className="text-4xl font-bold">OPAVC</text>
          </svg>
        </div>
        <h1 className="text-4xl font-bold mb-4">About OPAVC</h1>
        <p className="text-xl text-gray-600 max-w-2xl mx-auto">
          OPAVC is an open-source screen recording tool built for everyone. Our mission is to make screen recording accessible, private, and powerful.
        </p>
      </div>
      <div className="mt-[120px]">
        <div className="relative z-10 px-5 pt-24 pb-36 w-full">
          <div className="mx-auto text-center wrapper wrapper-sm">
            <h1 className="fade-in-down text-[2rem] font-bold leading-[2.5rem] md:text-[3.75rem] md:leading-[4rem] relative z-10 text-black mb-4">
              About OPAVC
            </h1>
            <p className="mx-auto mb-8 max-w-3xl text-md sm:text-xl text-zinc-500 fade-in-down animate-delay-1">
              Screen recording made simple, secure, and powerful. OPAVC gives you
              full control over your recordings with a focus on privacy and ease
              of use.
            </p>
          </div>
          <div className="flex flex-col justify-center items-center mb-5 space-y-2 fade-in-up animate-delay-2 sm:flex-row sm:space-y-0 sm:space-x-2">
            <Button
              variant="white"
              href="#video"
              size="lg"
              className="flex justify-center items-center w-full font-medium text-md sm:w-auto"
              onClick={(e) => handleSmoothScroll(e, "video")}
            >
              See it in Action
            </Button>
            <Button
              variant="radialblue"
              href="/download"
              size="lg"
              className="relative z-[20] w-full font-medium text-md sm:w-auto"
            >
              Download OPAVC
            </Button>
          </div>
          <img
            src="/illustrations/mask-big-recorder.webp"
            alt="About Background"
            className="absolute top-0 left-0 z-0 -mt-40 w-full h-auto pointer-events-none"
          />
        </div>

        {/* Main Content */}
        <div className="wrapper py-24 bg-gradient-to-b from-white to-gray-50">
          <div className="max-w-4xl mx-auto">
            <div className="p-8 bg-white rounded-2xl border border-gray-100/60 backdrop-blur-sm mb-12 shadow-[0_0_15px_rgba(0,0,0,0.03)] hover:shadow-[0_5px_30px_rgba(0,0,0,0.05)] transition-all duration-300">
              <p className="text-lg">
                Your recordings shouldn't be locked away in systems you don't
                control. At OPAVC, we're building a screen recording tool that
                puts you first, respects your privacy, and gives you full
                control over your content.
              </p>
            </div>

            <div className="mb-12" id="video">
              <div className="text-center max-w-[800px] mx-auto mb-10">
                <h2 className="text-3xl font-bold text-gray-800 mb-6 relative inline-block">
                  See OPAVC In Action
                  <span className="absolute -bottom-2 left-1/2 transform -translate-x-1/2 w-20 h-1 bg-blue-500 rounded-full"></span>
                </h2>
              </div>
              <div className="max-w-3xl mx-auto">
                <div className="rounded-xl overflow-hidden shadow-[0_0_20px_rgba(0,0,0,0.08)]">
                  <MuxPlayer
                    playbackId="A6oZoUWVZjOIVZB6XnBMLagYnXE6xhDhp8Hcyky018hk"
                    metadataVideoTitle="OPAVC Demo"
                    accentColor="#5C9FFF"
                    style={{ aspectRatio: "16/9", width: "100%" }}
                  />
                </div>
              </div>
            </div>

            <div className="space-y-8">
              <div className="p-8 bg-white rounded-2xl border border-gray-100/60 backdrop-blur-sm shadow-[0_0_15px_rgba(0,0,0,0.03)] hover:shadow-[0_5px_30px_rgba(0,0,0,0.05)] hover:border-blue-100/40 transition-all duration-300 transform hover:-translate-y-[2px]">
                <h2 className="text-2xl font-semibold mb-4 text-gray-800">
                  Why OPAVC?
                </h2>
                <p className="text-gray-600 leading-relaxed">
                  OPAVC started with a simple idea: great ideas should be easy to
                  share. Whether you're explaining a concept, showing how
                  something works, or working with others, the tools you use
                  should make your job easier, not harder.
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                <div className="p-8 bg-white rounded-2xl border border-gray-100/60 backdrop-blur-sm shadow-[0_0_15px_rgba(0,0,0,0.03)] hover:shadow-[0_5px_30px_rgba(0,0,0,0.05)] hover:border-blue-100/40 transition-all duration-300 transform hover:-translate-y-[2px]">
                  <div className="bg-blue-50 w-12 h-12 flex items-center justify-center rounded-full mb-4">
                    <span className="text-blue-500 text-xl font-bold">1</span>
                  </div>
                  <h2 className="text-2xl font-semibold mb-4 text-gray-800">
                    The Problem
                  </h2>
                  <p className="text-gray-600 leading-relaxed">
                    After years of using other screen recording tools, we found
                    they often don't respect your privacy, limit what you can
                    do, and lock your content in their systems. Most of these
                    tools are run by big companies that are slow to improve and
                    don't listen to what users actually need.
                  </p>
                </div>

                <div className="p-8 bg-white rounded-2xl border border-gray-100/60 backdrop-blur-sm shadow-[0_0_15px_rgba(0,0,0,0.03)] hover:shadow-[0_5px_30px_rgba(0,0,0,0.05)] hover:border-blue-100/40 transition-all duration-300 transform hover:-translate-y-[2px]">
                  <div className="bg-blue-50 w-12 h-12 flex items-center justify-center rounded-full mb-4">
                    <span className="text-blue-500 text-xl font-bold">2</span>
                  </div>
                  <h2 className="text-2xl font-semibold mb-4 text-gray-800">
                    Our Solution
                  </h2>
                  <p className="text-gray-600 leading-relaxed">
                    So we built OPAVC—a simple, complete screen recording tool
                    that anyone can use. Inspired by tools we love and built on
                    principles we believe in, our goal is to help you share
                    ideas easily while keeping control of your content. OPAVC
                    makes your recordings better with features like automatic
                    captions, easy zooming, simple editing, and flexible sharing
                    options.
                  </p>
                </div>
              </div>

              <div className="p-8 bg-white rounded-2xl border border-gray-100/60 backdrop-blur-sm shadow-[0_0_15px_rgba(0,0,0,0.03)] hover:shadow-[0_5px_30px_rgba(0,0,0,0.05)] hover:border-blue-100/40 transition-all duration-300 transform hover:-translate-y-[2px]">
                <h2 className="text-2xl font-semibold mb-4 text-gray-800">
                  Two Ways to Record
                </h2>
                <p className="text-gray-600 leading-relaxed mb-6">
                  OPAVC gives you two simple ways to record:
                </p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="p-6 bg-blue-50/50 rounded-xl border border-blue-100/20">
                    <h3 className="text-xl font-semibold text-blue-700 mb-3">
                      Instant Mode
                    </h3>
                    <p className="text-gray-600">
                      Share your screen right away with a simple link—no
                      waiting, just record and share in seconds.
                    </p>
                  </div>
                  <div className="p-6 bg-blue-50/50 rounded-xl border border-blue-100/20">
                    <h3 className="text-xl font-semibold text-blue-700 mb-3">
                      Studio Mode
                    </h3>
                    <p className="text-gray-600">
                      Records at top quality. Captures both your screen and
                      webcam separately so you can edit them later.
                    </p>
                  </div>
                </div>
              </div>

              <div className="p-8 bg-white rounded-2xl border border-gray-100/60 backdrop-blur-sm shadow-[0_0_15px_rgba(0,0,0,0.03)] hover:shadow-[0_5px_30px_rgba(0,0,0,0.05)] hover:border-blue-100/40 transition-all duration-300 transform hover:-translate-y-[2px]">
                <h2 className="text-2xl font-semibold mb-4 text-gray-800">
                  Privacy First
                </h2>
                <p className="text-gray-600 leading-relaxed">
                  Unlike other tools, OPAVC is built with your privacy as a top
                  priority. We don't trap your data or force you to use only our
                  systems. You can connect your own storage, keeping complete
                  control of your recordings forever.
                </p>
              </div>

              <div className="p-8 bg-white rounded-2xl border border-gray-100/60 backdrop-blur-sm shadow-[0_0_15px_rgba(0,0,0,0.03)] hover:shadow-[0_5px_30px_rgba(0,0,0,0.05)] hover:border-blue-100/40 transition-all duration-300 transform hover:-translate-y-[2px]">
                <h2 className="text-2xl font-semibold mb-4 text-gray-800">
                  Open to Everyone
                </h2>
                <p className="text-gray-600 leading-relaxed">
                  We believe in being open and transparent. OPAVC's code is
                  available for anyone to see, use, and improve. This means your
                  data will always be accessible, and our tool will keep getting
                  better through community feedback and contributions.
                </p>
              </div>

              <div className="p-8 bg-white rounded-2xl border border-gray-100/60 backdrop-blur-sm shadow-[0_0_15px_rgba(0,0,0,0.03)] hover:shadow-[0_5px_30px_rgba(0,0,0,0.05)] hover:border-blue-100/40 transition-all duration-300 transform hover:-translate-y-[2px]">
                <h2 className="text-2xl font-semibold mb-4 text-gray-800">
                  Join Us
                </h2>
                <p className="text-gray-600 leading-relaxed">
                  We're working to make OPAVC the best screen recording tool for
                  everyone. Whether you're creating content alone, working with
                  a startup, or part of a large team, OPAVC works for you.
                </p>
                <p className="text-gray-600 leading-relaxed mt-3">
                  Together, we're making it easier for everyone to share ideas
                  and connect—one recording at a time.
                </p>
                <div className="mt-6">
                  <Button
                    className="inline-flex shadow-[0_4px_14px_rgba(0,0,0,0.1)] hover:shadow-[0_6px_20px_rgba(0,118,255,0.23)] transform hover:-translate-y-[2px] transition-all duration-300"
                    href="/download"
                    variant="primary"
                    size="lg"
                  >
                    Download OPAVC
                  </Button>
                </div>
              </div>
            </div>
          </div>

          {/* Final CTA Section */}
          <div
            className="max-w-[1000px] mx-auto rounded-3xl overflow-hidden relative flex flex-col justify-center p-12 mt-16"
            style={{
              minHeight: "300px",
              background:
                "linear-gradient(135deg, #4f46e5 0%, #3b82f6 50%, #0ea5e9 100%)",
              boxShadow: "0 15px 50px rgba(0, 118, 255, 0.1)",
            }}
          >
            <div className="wrapper mx-auto h-full flex flex-col justify-center items-center relative z-10">
              <div className="text-center max-w-[800px] mx-auto mb-8">
                <h2 className="text-3xl md:text-4xl font-bold text-white mb-4 drop-shadow-md">
                  Ready to Try OPAVC?
                </h2>
                <p className="text-xl text-white/90 mb-6">
                  Download now and see the difference for yourself.
                </p>
              </div>
              <div>
                <Button
                  variant="white"
                  href="/download"
                  size="lg"
                  className="shadow-[0_4px_14px_rgba(0,0,0,0.05)] hover:shadow-[0_8px_30px_rgba(255,255,255,0.2)] transform hover:-translate-y-[2px] transition-all duration-300 font-medium px-8 py-3"
                >
                  Download OPAVC
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
