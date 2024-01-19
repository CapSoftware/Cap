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
    </>
  );
}
