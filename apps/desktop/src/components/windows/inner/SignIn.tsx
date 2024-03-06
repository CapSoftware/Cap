"use client";

import { Button, Logo } from "@cap/ui";
import { useState } from "react";
import { login } from "@/utils/auth";

export const SignIn = () => {
  const [loading, setLoading] = useState(false);

  const handleSignIn = async () => {
    setLoading(true);

    if (window.fathom !== undefined) {
      window.fathom.trackEvent("signin_started");
    }

    login();
  };

  return (
    <div
      data-tauri-drag-region
      className="flex items-center justify-center flex-col items-center justify-center w-full"
    >
      <div className="w-full wrapper wrapper-sm">
        <div className="mb-12">
          <Logo className="w-[110px] h-auto mx-auto" />
        </div>
        <div>
          <Button
            onClick={() => {
              handleSignIn();
            }}
            type="button"
            disabled={loading}
            className="mx-auto block"
          >
            Sign in with your browser
          </Button>
        </div>
      </div>
    </div>
  );
};
