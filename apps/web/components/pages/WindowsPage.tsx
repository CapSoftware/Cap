"use client";

import { useState } from "react";
import Link from "next/link";
import { Button, Input } from "@cap/ui";

export const WindowsPage = () => {
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setIsSubmitting(true);

    const formData = new FormData(e.currentTarget);

    try {
      const response = await fetch(
        "https://track.bentonow.com/forms/7d5c45ace4c02e5587c4449b1f0efb5c/$windowsAccess",
        {
          method: "POST",
          mode: "no-cors",
          body: formData,
        }
      );

      setIsSubmitted(true);
    } catch (error) {
      console.error("Error submitting form:", error);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-[calc(100vh-80px)] bg-gradient-to-b from-gray-100 to-white flex items-center">
      <div className="wrapper mx-auto">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 items-center">
          <div className="text-center md:text-left order-2 md:order-1 px-4 md:px-0">
            {!isSubmitted ? (
              <>
                <h1 className="text-[2rem] leading-[2.5rem] md:text-[3.75rem] md:leading-[4rem] mb-4">
                  Cap for Windows
                </h1>
                <p className="text-base sm:text-xl max-w-xl mb-8">
                  Join the waitlist to get notified when Cap is available for
                  Windows.
                </p>
                <form
                  onSubmit={handleSubmit}
                  className="max-w-md mx-auto md:mx-0"
                >
                  <Input
                    type="email"
                    name="email"
                    placeholder="Email address"
                    className="w-full max-w-full mb-4 placeholder:text-gray-300"
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
                <p className="text-base sm:text-xl max-w-2xl mb-8">
                  We'll be in touch as soon as Cap for Windows is ready. In the
                  meantime, you can{" "}
                  <Link
                    href="https://cap.link/discord"
                    className="font-bold underline text-base sm:text-xl"
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
          <div className="order-1 md:order-2 relative h-full flex items-center justify-center">
            <img
              src="/illustrations/windows-bg.jpg"
              alt="Cap for Windows Preview"
              className="w-full max-w-[250px] sm:max-w-[350px] md:max-w-[500px] rounded-lg shadow-lg"
            />
          </div>
        </div>
      </div>
    </div>
  );
};
