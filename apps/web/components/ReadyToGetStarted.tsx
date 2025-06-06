"use client";

import { Button } from "@cap/ui";

export function ReadyToGetStarted() {
  return (
    <div
      className="custom-bg max-w-[1000px] mx-auto rounded-[20px] overflow-hidden relative flex flex-col justify-center p-8"
      style={{ minHeight: "264px" }}
    >
      <div
        id="cloud-4"
        className="absolute top-0 -right-20 z-0 opacity-50 pointer-events-none"
      >
        <img
          className="max-w-[40vw] h-auto"
          src="/illustrations/cloud-1.png"
          alt="Footer Cloud One"
        />
      </div>
      <div
        id="cloud-5"
        className="absolute bottom-0 left-0 z-0 opacity-50 pointer-events-none"
      >
        <img
          className="max-w-[40vw] h-auto"
          src="/illustrations/cloud-2.png"
          alt="Footer Cloud Two"
        />
      </div>
      <div className="flex relative z-10 flex-col justify-center items-center mx-auto h-full wrapper">
        <div className="text-center max-w-[800px] mx-auto mb-8">
          <h2 className="mb-3 text-xl text-white sm:text-3xl">
            Beautiful screen recordings, owned by you.
          </h2>
          <p className="text-[1rem] sm:text-lg text-white">
            Cap is the open source alternative to Loom. Lightweight, powerful,
            and cross-platform. Record and share securely in seconds with custom
            S3 bucket support.
          </p>
        </div>
        <div className="flex flex-col justify-center items-center space-y-2 sm:flex-row sm:space-y-0 sm:space-x-2">
          <Button
            variant="white"
            href="/pricing"
            size="lg"
            className="w-full sm:w-auto"
          >
            Get Started
          </Button>
          <Button
            variant="primary"
            href="/download"
            size="lg"
            className="w-full sm:w-auto"
          >
            Download App
          </Button>
        </div>
      </div>
    </div>
  );
}
