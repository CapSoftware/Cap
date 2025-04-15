import { getCurrentUser } from "@cap/database/auth/session";
import { Button, LogoBadge } from "@cap/ui";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { LoginForm } from "./form";

export default async function LoginPage() {
  const session = await getCurrentUser();

  if (session) {
    redirect("/dashboard");
  }

  return (
    <div className="flex justify-center items-center w-full h-screen">
      <div className="overflow-hidden relative w-[calc(100%-2%)] p-[28px] max-w-[472px] space-y-[28px] bg-gray-100 border border-gray-200 rounded-2xl">
        <Link href="/">
          <LogoBadge className="w-[72px] mx-auto" />
        </Link>
        <div className="flex flex-col justify-center items-center text-left">
          <h1 className="text-2xl font-semibold">Sign in to Cap</h1>
          <p className="text-[16px] text-gray-400">
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
                <div className="mx-auto w-3/4 h-5 bg-gray-100 rounded-lg" />
              </>
            }
          >
            <LoginForm />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
