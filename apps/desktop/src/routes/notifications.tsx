import { events } from "~/utils/tauri";
import toast, { Toaster } from "solid-toast";

export default function Page() {
  events.newNotification.listen((e) => {
    toast.success(e.payload.body);
  });

  return (
    <>
      <style>
        {`
          body {
            background: transparent !important;
          }
        `}
      </style>
      <Toaster />
    </>
  );
}
