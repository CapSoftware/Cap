import { supabase } from "@/utils/database/supabase/client";

export const handleActiveSpace = async (spaceId: string) => {
  const { error: userUpdateError } = await supabase
    .from("users")
    .update({ active_space_id: spaceId });

  if (userUpdateError) {
    console.error(userUpdateError);
    return false;
  }

  return true;
};

const getSession = async () => {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  const { access_token, refresh_token }: any = session;

  await setSession(access_token, refresh_token);

  return session;
};

const refreshSession = async () => {
  const {
    data: { session },
  } = await supabase.auth.refreshSession();

  return session;
};

const setSession = async (access_token: string, refresh_token: string) => {
  const { data, error } = await supabase.auth.setSession({
    access_token,
    refresh_token,
  });

  return true;
};
