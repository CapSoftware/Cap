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
        className="absolute top-0 -right-20 opacity-50 z-0 pointer-events-none"
      >
        <img
          className="max-w-[40vw] h-auto"
          src="/illustrations/cloud-1.png"
          alt="Footer Cloud One"
        />
      </div>
      <div
        id="cloud-5"
        className="absolute bottom-0 left-0 opacity-50 z-0 pointer-events-none"
      >
        <img
          className="max-w-[40vw] h-auto"
          src="/illustrations/cloud-2.png"
          alt="Footer Cloud Two"
        />
      </div>
      <div className="wrapper mx-auto h-full flex flex-col justify-center items-center relative z-10">
        <div className="text-center max-w-[800px] mx-auto mb-8">
          <h2 className="text-4xl font-bold mb-4">Ready to Get Started?</h2>
          <p className="text-gray-600 mb-8">Professional screen recording platform by OPAVC</p>
        </div>
        <div className="flex flex-col sm:flex-row items-center justify-center space-y-2 sm:space-y-0 sm:space-x-2">
          <Button
            variant="white"
            href="/pricing"
            size="lg"
            className="w-full sm:w-auto"
          >
            Get Started
          </Button>
          <Button
            variant="secondary"
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
