"use client";

import { Button, Logo } from "@cap/ui";
import { signIn } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "react-hot-toast";

export const SignIn = () => {
  const searchParams = useSearchParams();
  const next = searchParams?.get("next");
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const error = searchParams?.get("error");
    error && toast.error(error);
  }, [searchParams]);

  return (
    <div className="w-[85%] h-[85%] flex items-center justify-center overflow-hidden px-2 py-4 rounded-[25px] border-2 border-gray-100  bg-gradient-to-b from-gray-200 to-white flex flex-col items-center justify-center">
      <div className="wrapper wrapper-sm">
        <div className="mb-12">
          <Logo className="w-32 h-auto mx-auto" />
        </div>
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
                console.log("res");
                console.log(res);
                setLoading(false);
                if (res?.ok && !res?.error) {
                  setEmail("");
                  toast.success("Email sent - check your inbox!");
                } else {
                  toast.error("Error sending email - try again?");
                }
              })
              .catch((err) => {
                console.log("err");
                console.log(err);
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
              placeholder="tim@apple.com"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
              }}
              className="mt-1 block w-full appearance-none rounded-md border border-gray-300 px-3 py-2 placeholder-gray-400 shadow-sm focus:border-black focus:outline-none focus:ring-black sm:text-sm"
            />
          </div>
          <Button variant="default" type="submit" disabled={loading}>
            Continue with Email
          </Button>
        </form>
      </div>
    </div>
  );
};
