import { listen } from "@tauri-apps/api/event";
import "./App.css";
import { MediaDeviceProvider } from "@/utils/recording/MediaDeviceContext";

function App({ children }: { children: React.ReactNode }) {
  return <MediaDeviceProvider>{children}</MediaDeviceProvider>;
}

listen("scheme-request-received", ({ payload }) => {
  console.log("scheme-request-received");
  console.log(payload);
});

export default App;
