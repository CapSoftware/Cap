"use client";

import { Button, Logo } from "@cap/ui";
import { useState } from "react";
import { login } from "@/utils/auth";

export const SignIn = () => {
  const [loading, setLoading] = useState(false);

  const handleSignIn = async () => {
    setLoading(true);

    login();
  };

  return (
    <div
      data-tauri-drag-region
      className="flex items-center justify-center overflow-hidden flex-col items-center justify-center"
    >
      <div className="wrapper wrapper-sm">
        <div className="mb-12">
          <Logo className="w-32 h-auto mx-auto" />
        </div>
        <div>
          <Button
            onClick={() => {
              handleSignIn();
            }}
            variant="default"
            type="button"
            disabled={loading}
            className="w-full"
          >
            Sign in with browser
          </Button>
        </div>
      </div>
    </div>
  );
};
