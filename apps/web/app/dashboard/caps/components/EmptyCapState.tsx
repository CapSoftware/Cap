import { Button } from "@cap/ui";
import { useRive } from "@rive-app/react-canvas";

interface EmptyCapStateProps {
  userName?: string;
}

export const EmptyCapState: React.FC<EmptyCapStateProps> = ({ userName }) => {
  const { rive, RiveComponent: EmptyCap } = useRive({
    src: "/rive/capsempty.riv",
    artboard: "empty",
    autoplay: true,
  });
  return (
    <div className="flex flex-col flex-1 justify-center items-center w-full">
      <div className="flex flex-col gap-3 items-center h-full text-center">
        <div className="mx-auto w-full mb-10 max-w-[450px] flex justify-center items-center">
          <EmptyCap className="h-[150px] w-[400px]" />
        </div>
        <div className="flex flex-col items-center">
          <p className="mb-1 text-xl font-semibold text-gray-500">
            Hey{userName ? ` ${userName}` : ""}! Record your first Cap
          </p>
          <p className="max-w-md text-gray-400 text-md">
            Craft your narrative with Cap - get projects done quicker.
          </p>
        </div>
        <div className="flex justify-center mt-4">
          <Button
            size="lg"
            href="/download"
            className="relative"
            variant="primary"
          >
            Download Cap
          </Button>
        </div>
      </div>
    </div>
  );
};
