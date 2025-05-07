"use client";

import { getOrganization } from "@/actions/organization/get-organization";
import { NODE_ENV } from "@cap/env";
import { Button, Input, LogoBadge } from "@cap/ui";
import {
  faArrowLeft,
  faExclamationCircle,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { AnimatePresence, motion } from "framer-motion";
import { LucideArrowUpRight, LucideMail } from "lucide-react";
import { signIn } from "next-auth/react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { toast } from "sonner";
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
  const [organizationName, setOrganizationName] = useState<string | null>(null);
  const theme = localStorage.getItem("theme") || "light";

  useEffect(() => {
    theme === "dark"
      ? document.documentElement.classList.add("dark")
      : document.documentElement.classList.remove("dark");
    return () => {
      document.documentElement.classList.remove("dark");
    };
  }, [theme]);

  useEffect(() => {
    const error = searchParams?.get("error");
    const errorDesc = searchParams?.get("error_description");

    const handleErrors = () => {
      if (error === "OAuthAccountNotLinked" && !errorDesc) {
        setOauthError(true);
        return toast.error(
          "This email is already associated with a different sign-in method"
        );
      } else if (
        error === "profile_not_allowed_outside_organization" &&
        !errorDesc
      ) {
        return toast.error(
          "Your email domain is not authorized for SSO access. Please use your work email or contact your administrator."
        );
      } else if (error && errorDesc) {
        return toast.error(errorDesc);
      }
    };
    handleErrors();
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

  const handleOrganizationLookup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!organizationId) {
      toast.error("Please enter an organization ID");
      return;
    }

    try {
      const data = await getOrganization(organizationId);
      setOrganizationName(data.name);

      signIn("workos", undefined, {
        organization: data.organizationId,
        connection: data.connectionId,
      });
    } catch (error) {
      console.error("Lookup Error:", error);
      toast.error("Organization not found or SSO not configured");
    }
  };

  return (
    <div className="flex justify-center items-center w-full h-screen bg-gray-1">
      <div className="overflow-hidden relative w-[calc(100%-5%)] p-[28px] max-w-[472px] bg-gray-2 border border-gray-4 rounded-2xl">
        <motion.div
          key="back-button"
          initial={{ opacity: 0, display: "none" }}
          animate={{
            opacity: showOrgInput ? 1 : 0,
            display: showOrgInput ? "flex" : "none",
            transition: { duration: 0.2 },
          }}
          onClick={() => setShowOrgInput(false)}
          className="flex absolute top-5 left-5 z-20 hover:bg-gray-1 gap-2 items-center py-1.5 px-3 text-gray-12 bg-transparent rounded-full border border-gray-4 transition-colors duration-300 cursor-pointer "
        >
          <FontAwesomeIcon className="w-2" icon={faArrowLeft} />
          <p className="text-xs text-inherit">Back</p>
        </motion.div>
        <Link className="flex mx-auto w-fit" href="/">
          <LogoBadge className="w-[72px] mx-auto" />
        </Link>
        <div className="flex flex-col justify-center items-center my-7 text-left">
          <h1 className="text-2xl font-semibold text-gray-12">
            Sign in to Cap
          </h1>
          <p className="text-[16px] text-gray-10">
            Beautiful screen recordings, owned by you.
          </p>
        </div>
        <div className="flex flex-col space-y-3">
          <Suspense
            fallback={
              <>
                <Button disabled={true} variant="primary" />
                <Button disabled={true} variant="secondary" />
                <Button disabled={true} variant="destructive" />
                <div className="mx-auto w-3/4 h-5 rounded-lg bg-gray-1" />
              </>
            }
          >
            <div className="flex flex-col space-y-3">
              <AnimatePresence mode="wait" initial={false}>
                {showOrgInput ? (
                  <motion.div
                    key="sso"
                    initial={{ x: 450, opacity: 0, filter: "blur(10px)" }}
                    animate={{ x: 0, opacity: 1, filter: "blur(0px)" }}
                    exit={{ x: 450, opacity: 0, filter: "blur(10px)" }}
                    transition={{ duration: 0.2, type: "spring", bounce: 0.2 }}
                  >
                    <LoginWithSSO
                      handleOrganizationLookup={handleOrganizationLookup}
                      organizationId={organizationId}
                      setOrganizationId={setOrganizationId}
                      organizationName={organizationName}
                    />
                  </motion.div>
                ) : (
                  <motion.form
                    key="email"
                    initial={{ x: -450, opacity: 0, filter: "blur(10px)" }}
                    animate={{ x: 0, opacity: 1, filter: "blur(0px)" }}
                    exit={{ x: -450, opacity: 0, filter: "blur(10px)" }}
                    transition={{ duration: 0.2, type: "spring", bounce: 0.2 }}
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
                        ...(next && next.length > 0
                          ? { callbackUrl: next }
                          : {}),
                      })
                        .then((res) => {
                          setLoading(false);
                          if (res?.ok && !res?.error) {
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
                    <NormalLogin
                      setShowOrgInput={setShowOrgInput}
                      email={email}
                      emailSent={emailSent}
                      setEmail={setEmail}
                      loading={loading}
                      oauthError={oauthError}
                      handleGoogleSignIn={handleGoogleSignIn}
                    />
                  </motion.form>
                )}
              </AnimatePresence>
              <p className="pt-3 text-xs text-center text-gray-8">
                By typing your email and clicking continue, you acknowledge that
                you have both read and agree to Cap's{" "}
                <Link
                  href="/terms"
                  target="_blank"
                  className="text-xs font-semibold text-gray-12 hover:text-blue-300"
                >
                  Terms of Service
                </Link>{" "}
                and{" "}
                <Link
                  href="/privacy"
                  target="_blank"
                  className="text-xs font-semibold text-gray-12 hover:text-blue-300"
                >
                  Privacy Policy
                </Link>
                .
              </p>
            </div>
            {emailSent && (
              <button
                className="pt-3 mx-auto text-sm underline text-gray-10 hover:text-gray-8"
                onClick={() => {
                  setEmailSent(false);
                  setEmail("");
                  setLoading(false);
                }}
              >
                Click to restart sign in process
              </button>
            )}
          </Suspense>
        </div>
      </div>
    </div>
  );
}

const LoginWithSSO = ({
  handleOrganizationLookup,
  organizationId,
  setOrganizationId,
  organizationName,
}: {
  handleOrganizationLookup: (e: React.FormEvent) => void;
  organizationId: string;
  setOrganizationId: (organizationId: string) => void;
  organizationName: string | null;
}) => {
  return (
    <>
      <form onSubmit={handleOrganizationLookup} className="relative space-y-2">
        <Input
          id="organizationId"
          placeholder="Enter your Organization ID..."
          value={organizationId}
          onChange={(e) => setOrganizationId(e.target.value)}
          className="w-full max-w-full"
        />
        {organizationName && (
          <p className="text-sm text-gray-1">
            Signing in to: {organizationName}
          </p>
        )}
        <div>
          <Button type="submit" variant="dark" className="w-full max-w-full">
            Continue with SSO
          </Button>
        </div>
      </form>
    </>
  );
};

const NormalLogin = ({
  setShowOrgInput,
  email,
  emailSent,
  setEmail,
  loading,
  oauthError,
  handleGoogleSignIn,
}: {
  setShowOrgInput: (show: boolean) => void;
  email: string;
  emailSent: boolean;
  setEmail: (email: string) => void;
  loading: boolean;
  oauthError: boolean;
  handleGoogleSignIn: () => void;
}) => {
  return (
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
      <div className="flex gap-4 items-center my-4">
        <span className="flex-1 h-px bg-gray-5" />
        <p className="text-sm text-center text-gray-8">OR</p>
        <span className="flex-1 h-px bg-gray-5" />
      </div>
      <div className="flex flex-col gap-3 justify-center items-center">
        {!oauthError && (
          <>
            <Button
              variant="red"
              type="button"
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
          </>
        )}

        {oauthError && (
          <div className="flex gap-3 items-center p-3 bg-red-400 rounded-xl border border-red-600">
            <FontAwesomeIcon
              className="text-gray-50 size-8"
              icon={faExclamationCircle}
            />
            <p className="text-xs leading-5 text-gray-50">
              It looks like you've previously used this email to sign up via
              email login. Please enter your email below to receive a sign in
              link.
            </p>
          </div>
        )}
        <Button
          variant="white"
          type="button"
          className="w-full"
          onClick={() => setShowOrgInput(true)}
          disabled={loading}
        >
          <LucideArrowUpRight size={20} />
          Login with SAML SSO
        </Button>
      </div>
    </>
  );
};
