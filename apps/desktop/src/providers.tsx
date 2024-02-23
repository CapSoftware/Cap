import { MediaDeviceProvider } from "@/utils/recording/MediaDeviceContext";
import { Toaster } from "react-hot-toast";

export function Providers({ children }) {
  return (
    <>
      <MediaDeviceProvider>{children}</MediaDeviceProvider>
      <Toaster />
    </>
  );
}
