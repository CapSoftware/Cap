import "./App.css";
import { MediaDeviceProvider } from "@/utils/recording/MediaDeviceContext";

function App({ children }: { children: React.ReactNode }) {
  return (
    <MediaDeviceProvider>
      <>{children}</>
    </MediaDeviceProvider>
  );
}

export default App;
