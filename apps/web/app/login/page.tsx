"use client";
import { useState, useRef, useEffect } from "react";
import { Button } from "ui";
import { LogoBadge } from "ui";
import { useSupabase } from "@/utils/database/supabase/provider";

export default function Login() {
  const [email, setEmail] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [success, setSuccess] = useState<boolean>(false);
  const { supabase } = useSupabase();

  const handleEmailLogin = async () => {
    setLoading(true);

    if (!email || email === "") {
      alert("Please enter your email address.");
      setLoading(false);
      return;
    }

    const { error } = await supabase.auth.signInWithOtp({
      email: email,
      options: {
        emailRedirectTo: `${process.env.NEXT_PUBLIC_URL}/dashboard`,
      },
    });

    if (error) {
      alert(error.message);
      setLoading(false);
      return;
    }

    setSuccess(true);
    setLoading(false);
  };

  return (
    <div>
      <div className="w-full h-full min-h-screen flex items-center relative">
        <div className="wrapper text-center">
          <div className="max-w-md mx-auto animate-fadeinfast overflow-hidden">
            <div className="bg-white p-10 space-y-6 text-sm">
              <div>
                <a href="/">
                  <LogoBadge className="h-16 w-auto mx-auto mb-3" />
                </a>
                <h1 className="text-3xl">Sign in to Cap</h1>
              </div>
              <div className="flex flex-col space-y-3">
                <div>
                  <label htmlFor="email">Email</label>
                  <input
                    id="email"
                    name="email"
                    type="email"
                    placeholder="you@email.com"
                    className="block w-full bg-white border border-gray-400 placeholder-gray-500 focus:outline-black shadow-sm rounded-lg py-3 px-5 text-black"
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </div>
                <Button onClick={() => handleEmailLogin()} variant="default">
                  {loading ? "Loading..." : "Continue with Email"}
                </Button>
              </div>
              {success && (
                <div>
                  <p className="text-black text-sm mt-4">
                    Your sign in link has been sent to the email you provided.
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
