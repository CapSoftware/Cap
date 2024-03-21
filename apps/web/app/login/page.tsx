import { Button, LogoBadge } from "@cap/ui";
import { Suspense } from "react";
import { LoginForm } from "./form";
import { getCurrentUser } from "@cap/database/auth/session";
import { redirect } from "next/navigation";

export default async function LoginPage() {
  const session = await getCurrentUser();

  console.log('session:')
  console.log(session);

  if (session) {
    redirect("/dashboard");
  }

  return (
    <div className="wrapper w-full h-screen flex items-center justify-center">
      <div className="relative overflow-hidden border-y border-gray-200 sm:rounded-2xl sm:border sm:shadow-xl">
        <div className="flex flex-col items-center justify-center space-y-3 border-b border-gray-200 bg-white px-4 py-6 pt-8 text-center sm:px-16">
          <a href="/">
            <LogoBadge className="h-12 w-auto" />
          </a>
          <h3 className="text-xl font-semibold">Sign in to Cap</h3>
          <p className="text-sm text-gray-500">
            Beautiful, shareable screen recordings. Open source and
            privacy-focused.
          </p>
        </div>
        <div className="flex flex-col space-y-3 bg-gray-50 px-4 py-8 sm:px-16">
          <Suspense
            fallback={
              <>
                <Button disabled={true} variant="default" />
                <Button disabled={true} variant="default" />
                <Button disabled={true} variant="default" />
                <div className="mx-auto h-5 w-3/4 rounded-lg bg-gray-100" />
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
