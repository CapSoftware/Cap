"use client";

import { Button } from "@cap/ui";
import { signIn } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "react-hot-toast";

export function LoginForm() {
  const searchParams = useSearchParams();
  const next = searchParams?.get("next");
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [emailSent, setEmailSent] = useState(false);
  const [oauthError, setOauthError] = useState(false);

  useEffect(() => {
    const error = searchParams?.get("error");
    if (error === "OAuthAccountNotLinked") {
      setOauthError(true);
      toast.error(error);
    }
  }, [searchParams]);

  useEffect(() => {
    const pendingPriceId = localStorage.getItem("pendingPriceId");
    if (emailSent && pendingPriceId) {
      // Clear the pending price ID
      localStorage.removeItem("pendingPriceId");

      // Wait a bit to ensure the user is created
      setTimeout(async () => {
        const response = await fetch(`/api/settings/billing/subscribe`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ priceId: pendingPriceId }),
        });
        const data = await response.json();

        if (data.url) {
          window.location.href = data.url;
        }
      }, 2000);
    }
  }, [emailSent]);

  const handleGoogleSignIn = () => {
    signIn("google", {
      ...(next && next.length > 0 ? { callbackUrl: next } : {}),
    });
  };

  return (
    <>
      <div className="flex flex-col space-y-3 fade-in-down animate-delay-2">
        {process.env.NODE_ENV === "development" && !oauthError && (
          <>
            <Button
              variant="dark"
              size="lg"
              className="h-12 text-lg flex items-center justify-center space-x-2"
              onClick={handleGoogleSignIn}
              disabled={loading}
            >
              <svg
                className="w-4 h-4"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 12 12"
              >
                <g fill="#E1E1E6" clipPath="url(#clip0)">
                  <path d="M11.762 6.138c0-.408-.033-.818-.104-1.22h-5.66V7.23H9.24a2.78 2.78 0 0 1-1.2 1.823v1.5h1.934c1.135-1.046 1.788-2.589 1.788-4.414"></path>
                  <path d="M5.999 12c1.618 0 2.983-.531 3.977-1.448l-1.933-1.5c-.538.367-1.233.574-2.042.574-1.565 0-2.892-1.056-3.369-2.476H.637v1.545A6 6 0 0 0 6 12"></path>
                  <path d="M2.63 7.15a3.6 3.6 0 0 1 0-2.297V3.307H.637a6 6 0 0 0 0 5.388z"></path>
                  <path d="M5.999 2.374a3.26 3.26 0 0 1 2.302.9l1.713-1.713A5.77 5.77 0 0 0 5.999 0 6 6 0 0 0 .637 3.307L2.63 4.852C3.104 3.43 4.434 2.374 6 2.374"></path>
                </g>
                <defs>
                  <clipPath id="clip0">
                    <path fill="#fff" d="M0 0h11.762v12H0z"></path>
                  </clipPath>
                </defs>
              </svg>
              <span className="text-gray-50">Continue with Google</span>
            </Button>

            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-blue-100" />
              </div>
              <div className="relative flex justify-center">
                <span className="bg-white px-2 text-gray-500 rounded-xl text-xs">
                  Or
                </span>
              </div>
            </div>
          </>
        )}

        {oauthError && (
          <div className="mb-4 p-4 bg-red-600 rounded-lg">
            <p className="text-sm text-gray-50">
              It looks like you've previously used this email to sign up via
              email login. Please enter your email below to receive a sign in
              link.
            </p>
          </div>
        )}

        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!email) return;

            setLoading(true);
            signIn("email", {
              email,
              redirect: false,
              ...(next && next.length > 0 ? { callbackUrl: next } : {}),
            })
              .then((res) => {
                setLoading(false);
                if (res?.ok && !res?.error) {
                  setEmail("");
                  setEmailSent(true);
                  toast.success("Email sent - check your inbox!");
                } else {
                  toast.error("Error sending email - try again?");
                }
              })
              .catch((err) => {
                setEmailSent(false);
                setLoading(false);
                toast.error("Error sending email - try again?");
              });
          }}
          className="flex flex-col space-y-3"
        >
          <div>
            <input
              id="email"
              name="email"
              autoFocus
              type="email"
              placeholder={emailSent ? "" : "tim@apple.com"}
              autoComplete="email"
              required
              value={email}
              disabled={emailSent}
              onChange={(e) => {
                setEmail(e.target.value);
              }}
              className="block w-full appearance-none rounded-full border border-gray-300 px-3 h-12 placeholder-gray-400 shadow-sm focus:border-black focus:outline-none focus:ring-black text-lg"
            />
            {process.env.NODE_ENV === "development" && (
              <div className="py-3 px-6 flex items-center justify-center bg-red-600 rounded-xl mt-3">
                <p className="text-white text-lg">
                  <span className="font-bold text-white">
                    Development mode:
                  </span>{" "}
                  Auth URL will be logged to your dev console.
                </p>
              </div>
            )}
          </div>
          <Button
            variant="primary"
            size="lg"
            className="h-12 text-lg"
            type="submit"
            disabled={loading || emailSent}
          >
            {emailSent
              ? process.env.NODE_ENV === "development"
                ? "Email sent to your terminal"
                : "Email sent to your inbox"
              : "Continue with Email"}
          </Button>
          <p className="text-xs text-gray-500 pt-2">
            By typing your email and clicking continue, you acknowledge that you
            have both read and agree to Cap's{" "}
            <a
              href="/terms"
              target="_blank"
              className="text-gray-600 font-semibold text-xs"
            >
              Terms of Service
            </a>{" "}
            and{" "}
            <a
              href="/privacy"
              target="_blank"
              className="text-gray-600 font-semibold text-xs"
            >
              Privacy Policy
            </a>
            .
          </p>
        </form>
      </div>
      {emailSent && (
        <div>
          <button
            className="mt-5 text-sm text-gray-500 underline hover:text-black"
            onClick={() => {
              setEmailSent(false);
              setEmail("");
              setLoading(false);
            }}
          >
            Click to restart sign in process.
          </button>
        </div>
      )}
    </>
  );
}
