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

  useEffect(() => {
    const error = searchParams?.get("error");
    error && toast.error(error);
  }, [searchParams]);

  return (
    <>
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
        className="flex flex-col space-y-3 fade-in-down animate-delay-2"
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
        </div>
        <Button
          variant="default"
          size="lg"
          className="h-12 text-lg"
          type="submit"
          disabled={loading || emailSent}
        >
          {emailSent ? "Email was sent to your inbox" : "Continue with Email"}
        </Button>
        <p className="text-xs text-gray-500 pt-2">
          By typing your email and clicking continue, you acknowledge that you
          have both read and agree to Cap's{" "}
          <a
            href="/terms"
            target="_blank"
            className="text-gray-600 font-semibold"
          >
            Terms of Service
          </a>{" "}
          and{" "}
          <a
            href="/privacy"
            target="_blank"
            className="text-gray-600 font-semibold"
          >
            Privacy Policy
          </a>
          .
        </p>
      </form>
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
