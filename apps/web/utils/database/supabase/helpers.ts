import type { TypedSupabaseClient } from "@/app/layout";

export const handleActiveSpace = async (
  spaceId: string,
  supabase: TypedSupabaseClient
) => {
  const { error: userUpdateError } = await supabase
    .from("users")
    .update({ active_space_id: spaceId });

  if (userUpdateError) {
    console.error(userUpdateError);
    return false;
  }

  return true;
};
