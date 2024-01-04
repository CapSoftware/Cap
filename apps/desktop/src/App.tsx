import "./App.css";
import { MediaDeviceProvider } from "@/utils/recording/MediaDeviceContext";
import { AuthProvider } from "@/utils/database/AuthContext";

function App({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <MediaDeviceProvider>{children}</MediaDeviceProvider>
    </AuthProvider>
  );
}

export default App;
