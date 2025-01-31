import { Dialog, DialogContent, LogoBadge, Button } from "@cap/ui";
import { NODE_ENV } from "@cap/env";
import { motion } from "framer-motion";
import { signIn } from "next-auth/react";
import { useState, useEffect } from "react";
import { toast } from "react-hot-toast";

interface AuthOverlayProps {
  isOpen: boolean;
  onClose: () => void;
}

const MotionDialogContent = motion(DialogContent);

export const AuthOverlay: React.FC<AuthOverlayProps> = ({
  isOpen,
  onClose,
}) => {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [emailSent, setEmailSent] = useState(false);

  const handleGoogleSignIn = () => {
    signIn("google");
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
          <LogoBadge className="h-12 w-auto" />

          <div className="text-left space-y-3">
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
              className="text-2xl text-gray-500"
            >
              Join the conversation.
            </motion.p>
          </div>

          <div className="flex flex-col space-y-3 fade-in-down animate-delay-2">
            {NODE_ENV !== "development" && (
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

            <form
              onSubmit={async (e) => {
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
                {NODE_ENV === "development" && (
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
                  ? NODE_ENV === "development"
                    ? "Email sent to your terminal"
                    : "Email sent to your inbox"
                  : "Continue with Email"}
              </Button>
              <p className="text-xs text-gray-500 pt-2">
                By typing your email and clicking continue, you acknowledge that
                you have both read and agree to Cap's{" "}
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
        </div>
      </MotionDialogContent>
    </Dialog>
  );
};
