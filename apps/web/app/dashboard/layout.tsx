"use server";
// import DynamicSharedLayout from "@/app/dashboard/_components/DynamicSharedLayout";
// import {
//   createSupabaseServerClient,
//   getSession,
//   getActiveSpace,
// } from "@/utils/database/supabase/server";
// import SupabaseProvider from "@/utils/database/supabase/provider";
// import SupabaseListener from "@/utils/database/supabase/listener";

//TODO: Auth

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // const supabase = await createSupabaseServerClient();
  // const spaceData = await supabase
  //   .from("spaces")
  //   .select("*")
  //   .order("created_at", { ascending: true });
  // const activeSpace = await getActiveSpace();
  // const session = await getSession();

  // console.log("session", session);

  return (
    <p></p>
    // <SupabaseProvider session={session}>
    //   <DynamicSharedLayout
    //     spaceData={spaceData?.data}
    //     activeSpace={activeSpace}
    //   >
    //     <SupabaseListener serverAccessToken={session?.access_token} />
    //     <div className="full-layout">{children}</div>
    //   </DynamicSharedLayout>
    // </SupabaseProvider>
  );
}
