import {
  Button,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@cap/ui";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faInfoCircle } from "@fortawesome/free-solid-svg-icons";
import { useRive, Fit, Layout } from "@rive-app/react-canvas";
import { useTheme } from "../DynamicSharedLayout";

const CapAIDialog = ({ setOpen }: { setOpen: (open: boolean) => void }) => {
  const { theme } = useTheme();
  const { RiveComponent: CapAIArt } = useRive({
    src: "/rive/bento.riv",
    artboard: theme === "light" ? "capai" : "capaidark",
    animations: ["in"],
    autoplay: true,
    layout: new Layout({
      fit: Fit.Contain,
    }),
  });
  return (
    <DialogContent
      onOpenAutoFocus={(e) => e.preventDefault()}
      className="w-[calc(100%-20px)] max-w-[500px]"
    >
      <DialogHeader icon={<FontAwesomeIcon icon={faInfoCircle} />}>
        <DialogTitle className="text-lg font-medium text-gray-12">
          Cap AI
        </DialogTitle>
      </DialogHeader>
      <div className="p-8">
        <CapAIArt className="w-full max-w-[450px] mx-auto h-[240px]" />
        <p className="pt-5 text-base text-gray-11">
          Cap AI is a powerful tool that allows you to generate Cap files using
          AI. With Cap AI, you can create Cap files quickly and easily, without
          the need for any technical expertise.
        </p>
      </div>
      <DialogFooter>
        <Button
          autoFocus={false}
          className="min-w-[100px] max-w-fit ml-auto"
          variant="primary"
          onClick={() => setOpen(false)}
        >
          Close
        </Button>
      </DialogFooter>
    </DialogContent>
  );
};

export default CapAIDialog;
