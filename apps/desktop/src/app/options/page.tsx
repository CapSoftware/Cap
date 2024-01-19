"use server";

// import { SignIn } from "@/components/windows/inner/SignIn";
import { Recorder } from "@/components/windows/inner/Recorder";
import { getCurrentUser } from "@cap/database/auth/session";
export default async function CameraPage() {
  const session = await getCurrentUser();

  if (!session) {
    return <Recorder />;
  }

  return <Recorder />;
}
