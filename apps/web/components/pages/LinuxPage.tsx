"use client";

import { Button, Input } from "@cap/ui";
import Link from "next/link";
import { useState } from "react";

export const LinuxPage = () => {
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setIsSubmitting(true);


    try {

      setIsSubmitted(true);
    } catch (error) {
      console.error("Error submitting form:", error);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-[calc(100vh-80px)] bg-gradient-to-b from-gray-100 to-white flex items-center">
      <div className="mx-auto wrapper">
        <div className="grid grid-cols-1 gap-8 items-center md:grid-cols-2">
          <div className="order-2 px-4 text-center md:text-left md:order-1 md:px-0">
            {!isSubmitted ? (
              <>
                <h1 className="text-[2rem] leading-[2.5rem] md:text-[3.75rem] md:leading-[4rem] mb-4">
                  Cap for Linux
                </h1>
                <p className="mb-8 max-w-xl text-base sm:text-xl">
                  Join the waitlist to get notified when Cap is available for
                  Linux.
                </p>
                <form
                  onSubmit={handleSubmit}
                  className="mx-auto max-w-md md:mx-0"
                >
                  <Input
                    type="email"
                    name="email"
                    placeholder="Email address"
                    className="mb-4 w-full max-w-full"
                    required
                    disabled={isSubmitting}
                  />
                  <Button
                    type="submit"
                    variant="primary"
                    size="lg"
                    className="w-full"
                    disabled={isSubmitting}
                    spinner={isSubmitting}
                  >
                    Join waitlist
                  </Button>
                </form>
              </>
            ) : (
              <>
                <h1 className="text-[2rem] leading-[2.5rem] md:text-[3.75rem] md:leading-[4rem] mb-4">
                  Thanks for joining
                </h1>
                <p className="mb-8 max-w-2xl text-base sm:text-xl">
                  We'll be in touch as soon as Cap for Windows is ready. In the
                  meantime, you can{" "}
                  <Link
                    href="https://cap.link/discord"
                    className="text-base font-bold underline sm:text-xl"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    join the Cap Discord
                  </Link>{" "}
                  for latest progress and instructions on how to build locally.
                </p>
              </>
            )}
          </div>
          <div className="flex relative order-1 justify-center items-center h-full md:order-2">
            <img
              src="/illustrations/linux.jpg"
              alt="Cap for Linux Preview"
              className="w-full max-w-[250px] sm:max-w-[350px] md:max-w-[500px] rounded-2xl shadow-lg"
            />
          </div>
        </div>
      </div>
    </div>
  );
};
