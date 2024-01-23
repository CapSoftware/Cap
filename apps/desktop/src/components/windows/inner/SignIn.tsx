"use client";

import { Button, Logo } from "@cap/ui";
import { useState } from "react";
import { login } from "@/utils/auth";
import { getCookie } from "cookies-next";

export const SignIn = () => {
  const [loading, setLoading] = useState(false);
  const cookie = getCookie("next-auth.session-token");

  const handleSignIn = async () => {
    setLoading(true);

    login();
  };

  const getData = async () => {
    if (!cookie) {
      return;
    }

    console.log("cookie:");
    console.log(cookie);

    const res = await fetch("http://localhost:3000/api/session/verify", {
      credentials: "include",
    });
    const data = await res.json();
    console.log("dataaa:");
    console.log(data);
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
        <Button
          onClick={() => {
            handleSignIn();
          }}
          variant="default"
          type="button"
          disabled={loading}
        >
          Sign in via Cap.so
        </Button>
        {cookie && (
          <button
            onClick={() => {
              getData();
            }}
          >
            get data
          </button>
        )}
      </div>
    </div>
  );
};
