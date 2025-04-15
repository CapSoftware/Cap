"use client";

import { getSpace } from "@/actions/workspace/get-space";
import { NODE_ENV } from "@cap/env";
import { Button, Input, Label } from "@cap/ui";
import { faArrowLeft } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { LucideArrowUpRight, LucideMail } from "lucide-react";
import { signIn } from "next-auth/react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "react-hot-toast";
import { trackEvent } from "../utils/analytics";

export function LoginForm() {
  const searchParams = useSearchParams();
  const next = searchParams?.get("next");
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [emailSent, setEmailSent] = useState(false);
  const [oauthError, setOauthError] = useState(false);
  const [showOrgInput, setShowOrgInput] = useState(false);
  const [organizationId, setOrganizationId] = useState("");
  const [spaceId, setSpaceId] = useState("");
  const [spaceName, setSpaceName] = useState<string | null>(null);

  useEffect(() => {
    const error = searchParams?.get("error");
    const errorDesc = searchParams?.get("error_description");

    if (error === "OAuthAccountNotLinked") {
      setOauthError(true);
      toast.error(
        "This email is already associated with a different sign-in method"
      );
    } else if (error === "profile_not_allowed_outside_organization") {
      toast.error(
        "Your email domain is not authorized for SSO access. Please use your work email or contact your administrator."
      );
    } else if (error && errorDesc) {
      toast.error(errorDesc);
    }
  }, [searchParams]);

  useEffect(() => {
    const pendingPriceId = localStorage.getItem("pendingPriceId");
    const pendingQuantity = localStorage.getItem("pendingQuantity") ?? "1";
    if (emailSent && pendingPriceId) {
      localStorage.removeItem("pendingPriceId");
      localStorage.removeItem("pendingQuantity");

      // Wait a bit to ensure the user is created
      setTimeout(async () => {
        const response = await fetch(`/api/settings/billing/subscribe`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            priceId: pendingPriceId,
            quantity: parseInt(pendingQuantity),
          }),
        });
        const data = await response.json();

        console.log(data);

        if (data.url) {
          window.location.href = data.url;
        }
      }, 2000);
    }
  }, [emailSent]);

  const handleGoogleSignIn = () => {
    trackEvent("auth_started", { method: "google", is_signup: true });
    signIn("google", {
      ...(next && next.length > 0 ? { callbackUrl: next } : {}),
    });
  };

  const handleSpaceLookup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!spaceId) {
      toast.error("Please enter a space ID");
      return;
    }

    try {
      const data = await getSpace(spaceId);
      setSpaceName(data.name);

      signIn("workos", undefined, {
        organization: data.organizationId,
        connection: data.connectionId,
      });
    } catch (error) {
      console.error("Lookup Error:", error);
      toast.error("Space not found or SSO not configured");
    }
  };

  return (
    <>
      <div className="flex flex-col space-y-3">
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!email) return;

            setLoading(true);
            trackEvent("auth_started", {
              method: "email",
              is_signup: !oauthError,
            });
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
                  trackEvent("auth_email_sent", {
                    email_domain: email.split("@")[1],
                  });
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
          {showOrgInput === false && (
            <>
              <div className="flex flex-col space-y-3">
                <Input
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
                />
                <Button
                  variant="primary"
                  type="submit"
                  disabled={loading || emailSent}
                  icon={<LucideMail size={16} />}
                >
                  {emailSent
                    ? NODE_ENV === "development"
                      ? "Email sent to your terminal"
                      : "Email sent to your inbox"
                    : "Login with email"}
                </Button>
                {/* {NODE_ENV === "development" && (
                  <div className="flex justify-center items-center px-6 py-3 mt-3 bg-red-600 rounded-xl">
                    <p className="text-lg text-white">
                      <span className="font-bold text-white">
                        Development mode:
                      </span>{" "}
                      Auth URL will be logged to your dev console.
                    </p>
                  </div>
                )} */}
              </div>
            </>
          )}
          {showOrgInput === false && (
            <div className="flex gap-4 items-center">
              <span className="flex-1 h-px bg-gray-200" />
              <p className="text-sm text-center text-gray-400">OR</p>
              <span className="flex-1 h-px bg-gray-200" />
            </div>
          )}
          {showOrgInput === false && (
            <div className="flex flex-col gap-3 justify-center items-center">
              {!oauthError && (
                <>
                  {showOrgInput === false && (
                    <Button
                      variant="red"
                      className="flex justify-center items-center space-x-2 w-full text-sm"
                      onClick={handleGoogleSignIn}
                      disabled={loading}
                    >
                      <svg
                        width="15"
                        height="16"
                        viewBox="0 0 15 16"
                        fill="none"
                        className="mr-1"
                        xmlns="http://www.w3.org/2000/svg"
                      >
                        <path
                          d="M15 8.1754C15 12.4546 12.0215 15.5 7.62295 15.5C3.40574 15.5 0 12.1492 0 8C0 3.85081 3.40574 0.5 7.62295 0.5C9.67623 0.5 11.4037 1.24093 12.7346 2.4627L10.6598 4.4254C7.9457 1.84879 2.89857 3.78427 2.89857 8C2.89857 10.6159 5.02254 12.7359 7.62295 12.7359C10.6414 12.7359 11.7725 10.6069 11.9508 9.50302H7.62295V6.92339H14.8801C14.9508 7.30746 15 7.67641 15 8.1754Z"
                          fill="white"
                        />
                      </svg>
                      Login with Google
                    </Button>
                  )}
                </>
              )}

              {oauthError && (
                <div className="p-4 mb-4 bg-red-600 rounded-lg">
                  <p className="text-sm text-gray-50">
                    It looks like you've previously used this email to sign up
                    via email login. Please enter your email below to receive a
                    sign in link.
                  </p>
                </div>
              )}
              <Button
                variant="white"
                className="w-full"
                onClick={() => setShowOrgInput(true)}
                disabled={loading}
              >
                <LucideArrowUpRight size={20} />
                Login with SAML SSO
              </Button>
            </div>
          )}
        </form>
        {showOrgInput && (
          <>
            <div
              onClick={() => setShowOrgInput(false)}
              className="flex absolute top-2 left-6 gap-2 items-center text-gray-500 transition-colors duration-300 cursor-pointer hover:text-gray-400"
            >
              <FontAwesomeIcon className="w-3" icon={faArrowLeft} />
              <p className="text-sm text-inherit">Back</p>
            </div>
            <form onSubmit={handleSpaceLookup} className="space-y-2">
              <div>
                <Label htmlFor="spaceId">Space ID</Label>
                <Input
                  id="spaceId"
                  value={spaceId}
                  onChange={(e) => setSpaceId(e.target.value)}
                  className="w-full max-w-full"
                />
              </div>
              {spaceName && (
                <p className="text-sm text-gray-500">
                  Signing in to: {spaceName}
                </p>
              )}
              <div>
                <Button
                  type="submit"
                  variant="dark"
                  className="w-full max-w-full"
                >
                  Continue with SSO
                </Button>
              </div>
            </form>
          </>
        )}
        <p className="text-xs text-center text-gray-400">
          By typing your email and clicking continue, you acknowledge that you
          have both read and agree to Cap's{" "}
          <Link
            href="/terms"
            target="_blank"
            className="text-xs font-semibold text-gray-500 hover:text-blue-300"
          >
            Terms of Service
          </Link>{" "}
          and{" "}
          <Link
            href="/privacy"
            target="_blank"
            className="text-xs font-semibold text-gray-500 hover:text-blue-300"
          >
            Privacy Policy
          </Link>
          .
        </p>
      </div>
      {emailSent && (
        <button
          className="pt-3 mx-auto text-sm text-gray-500 underline hover:text-gray-400"
          onClick={() => {
            setEmailSent(false);
            setEmail("");
            setLoading(false);
          }}
        >
          Click to restart sign in process
        </button>
      )}
    </>
  );
}
