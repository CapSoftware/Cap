import { Button } from "@cap/ui";
import { useRive } from "@rive-app/react-canvas";
import { UploadCapButton } from "./UploadCapButton";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faDownload } from "@fortawesome/free-solid-svg-icons";
import { useTheme } from "../../Contexts";

interface EmptyCapStateProps {
  userName?: string;
}

export const EmptyCapState: React.FC<EmptyCapStateProps> = ({ userName }) => {
  const { theme } = useTheme();
  const { RiveComponent: EmptyCap } = useRive({
    src: "/rive/main.riv",
    artboard: theme === "light" ? "empty" : "darkempty",
    autoplay: true,
  });
  return (
    <div className="flex flex-col flex-1 justify-center items-center w-full h-full">
      <div className="flex flex-col gap-3 justify-center items-center h-full text-center">
        <div className="mx-auto w-full mb-10 max-w-[450px] flex justify-center items-center">
          <EmptyCap key={theme + "empty-cap"} className="h-[150px] w-[400px]" />
        </div>
        <div className="flex flex-col items-center px-5">
          <p className="mb-1 text-xl font-semibold text-gray-12">
            Hey{userName ? ` ${userName}` : ""}! Record your first Cap
          </p>
          <p className="max-w-md text-gray-10 text-md">
            Craft your narrative with Cap - get projects done quicker.
          </p>
        </div>
        <div className="flex gap-3 justify-center items-center mt-4">
          <Button
            href="/download"
            className="flex relative gap-2 justify-center items-center"
            variant="primary"
          >
            <FontAwesomeIcon
              className="size-3.5"
              icon={faDownload}
            />
            Download Cap
          </Button>
          <p className="text-sm text-gray-10">or</p>
          <UploadCapButton />
        </div>
      </div>
    </div>
  );
};
