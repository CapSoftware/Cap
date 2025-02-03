import { Button } from "@cap/ui-solid";
import logo from "@assets/img/logo.svg";
import "@src/styles/index.css";

const Popup = () => {
  return (
    <div class="flex items-center justify-center min-h-screen p-4 flex-col bg-background">
      <div class="w-full max-w-md rounded-lg border p-6 space-y-4 bg-card border-border shadow-lg">
        <div class="flex items-center justify-center">
          <img src={logo} alt="Cap Logo" class="h-12 w-12" />
        </div>
        <h1 class="text-2xl font-semibold text-center text-foreground">
          Cap Importer Extension
        </h1>
        <div class="space-y-2">
          <Button class="w-full" variant="primary">
            Import Content
          </Button>
          <Button class="w-full" variant="secondary">
            Settings
          </Button>
        </div>
      </div>
    </div>
  );
};

export default Popup;
