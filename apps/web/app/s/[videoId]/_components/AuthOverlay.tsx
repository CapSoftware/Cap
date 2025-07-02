import { NODE_ENV } from "@cap/env";
import { Button, Dialog, DialogContent, LogoBadge } from "@cap/ui";
import { motion } from "framer-motion";
import { signIn } from "next-auth/react";
import { useState } from "react";
import { toast } from "sonner";

interface AuthOverlayProps {
  isOpen: boolean;
  onClose: () => void;
}

const MotionDialogContent = motion.create(DialogContent);

export const AuthOverlay: React.FC<AuthOverlayProps> = ({
  isOpen,
  onClose,
}) => {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [emailSent, setEmailSent] = useState(false);
  const [otpCode, setOtpCode] = useState("");
  const [verifyingOtp, setVerifyingOtp] = useState(false);

  const handleGoogleSignIn = () => {
    signIn("google");
  };

  const handleOtpVerification = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!otpCode || otpCode.length !== 6) {
      toast.error("Please enter a 6-digit verification code");
      return;
    }

    setVerifyingOtp(true);
    try {
      const result = await signIn("otp", {
        email,
        otp: otpCode,
        redirect: false,
      });

      if (result?.ok) {
        toast.success("Successfully signed in!");
        onClose();
        window.location.reload(); // Reload to update auth state
      } else if (result?.error) {
        toast.error("Invalid or expired verification code");
        setOtpCode("");
      } else {
        toast.error("Sign in failed. Please try again.");
      }
    } catch (error) {
      toast.error("Failed to verify code. Please try again.");
    } finally {
      setVerifyingOtp(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <MotionDialogContent
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        transition={{ duration: 0.2 }}
        className="w-[90vw] sm:max-w-md p-6 rounded-xl"
      >
        <div className="space-y-6">
          <LogoBadge className="w-auto h-12" />

          <div className="space-y-3 text-left">
            <motion.h1
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
              className="text-3xl font-semibold"
            >
              Sign in to comment
            </motion.h1>
            <motion.p
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2 }}
              className="text-2xl text-gray-1"
            >
              Join the conversation.
            </motion.p>
          </div>

          <div className="flex flex-col space-y-3 fade-in-down animate-delay-2">
            {NODE_ENV !== "development" && (
              <>
                <Button
                  variant="darkgradient"
                  size="lg"
                  className="flex justify-center items-center space-x-2 h-12 text-lg"
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
                  <div className="flex absolute inset-0 items-center">
                    <div className="w-full border-t border-blue-100" />
                  </div>
                  <div className="flex relative justify-center">
                    <span className="px-2 text-xs rounded-xl bg-gray-1 text-gray-1">
                      Or
                    </span>
                  </div>
                </div>
              </>
            )}

            <form
              onSubmit={
                emailSent
                  ? handleOtpVerification
                  : async (e) => {
                      e.preventDefault();
                      if (!email) return;

                      setLoading(true);
                      signIn("email", {
                        email,
                        redirect: false,
                      })
                        .then((res) => {
                          setLoading(false);
                          if (res?.ok && !res?.error) {
                            setEmailSent(true);
                            toast.success("Code sent - check your email!");
                          } else {
                            toast.error("Error sending code - try again?");
                          }
                        })
                        .catch(() => {
                          setEmailSent(false);
                          setLoading(false);
                          toast.error("Error sending code - try again?");
                        });
                    }
              }
              className="flex flex-col space-y-3"
            >
              {emailSent ? (
                <>
                  <p className="text-center text-sm">
                    Enter the 6-digit code sent to {email}
                  </p>
                  <input
                    id="otp"
                    name="otp"
                    type="text"
                    autoFocus
                    placeholder="000000"
                    maxLength={6}
                    pattern="[0-9]{6}"
                    autoComplete="one-time-code"
                    required
                    value={otpCode}
                    onChange={(e) => {
                      const value = e.target.value.replace(/\D/g, "");
                      setOtpCode(value.slice(0, 6));
                    }}
                    className="block px-3 w-full h-12 text-2xl tracking-widest font-mono text-center placeholder-gray-400 rounded-full border border-gray-300 shadow-sm appearance-none focus:border-black focus:outline-none focus:ring-black"
                  />
                  <Button
                    variant="primary"
                    size="lg"
                    className="h-12 text-lg"
                    type="submit"
                    disabled={verifyingOtp || otpCode.length !== 6}
                  >
                    {verifyingOtp ? "Verifying..." : "Verify Code"}
                  </Button>
                </>
              ) : (
                <>
                  <div>
                    <input
                      id="email"
                      name="email"
                      autoFocus
                      type="email"
                      placeholder="tim@apple.com"
                      autoComplete="email"
                      required
                      value={email}
                      onChange={(e) => {
                        setEmail(e.target.value);
                      }}
                      className="block px-3 w-full h-12 text-lg placeholder-gray-400 rounded-full border border-gray-300 shadow-sm appearance-none focus:border-black focus:outline-none focus:ring-black"
                    />
                    {NODE_ENV === "development" && (
                      <div className="flex justify-center items-center px-6 py-3 mt-3 bg-red-600 rounded-xl">
                        <p className="text-lg text-white">
                          <span className="font-medium text-white">
                            Development mode:
                          </span>{" "}
                          Code will be logged to your dev console.
                        </p>
                      </div>
                    )}
                  </div>
                  <Button
                    variant="primary"
                    size="lg"
                    className="h-12 text-lg"
                    type="submit"
                    disabled={loading}
                  >
                    {loading ? "Sending..." : "Send verification code"}
                  </Button>
                </>
              )}
              <p className="pt-2 text-xs text-gray-1">
                By typing your email and clicking continue, you acknowledge that
                you have both read and agree to Cap's{" "}
                <a
                  href="/terms"
                  target="_blank"
                  className="text-xs font-semibold text-gray-600"
                >
                  Terms of Service
                </a>{" "}
                and{" "}
                <a
                  href="/privacy"
                  target="_blank"
                  className="text-xs font-semibold text-gray-600"
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
                className="mt-5 text-sm underline text-gray-1 hover:text-black"
                onClick={() => {
                  setEmailSent(false);
                  setOtpCode("");
                  setLoading(false);
                }}
              >
                Use a different email
              </button>
            </div>
          )}
        </div>
      </MotionDialogContent>
    </Dialog>
  );
};
