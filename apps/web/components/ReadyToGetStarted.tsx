"use client";

import { Button } from "@cap/ui";
import { homepageCopy } from "../data/homepage-copy";
import Link from "next/link";

export function ReadyToGetStarted() {
  return (
    <div
      className="max-w-[1000px] md:bg-center w-[calc(100%-20px)] bg-white min-h-[300px] mx-auto border border-gray-5 my-[150px] md:my-[200px] lg:my-[250px] rounded-[20px] overflow-hidden relative flex flex-col justify-center p-8"
      style={{
        backgroundImage: "url('/illustrations/ctabg.svg')",
        backgroundSize: "cover",
        backgroundRepeat: "no-repeat",
      }}
    >
      <div className="flex relative z-10 flex-col justify-center items-center mx-auto h-full wrapper">
        <div className="text-center max-w-[800px] mx-auto mb-8">
          <h2 className="mb-3 text-3xl md:text-4xl text-gray-12">
            {homepageCopy.readyToGetStarted.title}
          </h2>
        </div>
        <div className="flex flex-col justify-center items-center space-y-4 sm:flex-row sm:space-y-0 sm:space-x-2 mb-8">
          <Button
            variant="gray"
            href="/pricing"
            size="lg"
            className="w-full font-medium sm:w-auto"
          >
            {homepageCopy.readyToGetStarted.buttons.secondary}
          </Button>
          <Button
            variant="blue"
            href="/download"
            size="lg"
            className="w-full font-medium sm:w-auto"
          >
            {homepageCopy.readyToGetStarted.buttons.primary}
          </Button>
        </div>
        <div>
          <p>
            or,{" "}
            <Link
              href="/loom-alternative"
              className="underline font-semibold hover:text-gray-12"
            >
              Switch from Loom
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
