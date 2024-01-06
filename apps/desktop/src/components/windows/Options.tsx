import { Recorder } from "@/components/windows/inner/Recorder";
import { SignIn } from "@/components/windows/inner/SignIn";
import { useAuth } from "@/utils/database/AuthContext";

export const Options = () => {
  const { session, userRef } = useAuth();

  const currentUser = userRef.current;

  if (currentUser) {
    return <Recorder session={session} />;
  }
  return <SignIn />;
};
