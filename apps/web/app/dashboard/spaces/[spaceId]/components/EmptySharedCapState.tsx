import { useRive } from "@rive-app/react-canvas";
import { useTheme } from "../../../_components/DynamicSharedLayout";

interface EmptySharedCapStateProps {
  organizationName: string;
  type?: "space" | "organization";
}

export const EmptySharedCapState: React.FC<EmptySharedCapStateProps> = ({
  organizationName,
  type = "organization",
}) => {
  const { theme } = useTheme();
  const { RiveComponent: EmptyCap } = useRive({
    src: "/rive/main.riv",
    artboard: theme === "light" ? "emptyshared" : "darkemptyshared",
    autoplay: true,
  });
  return (
    <div className="flex flex-col flex-1 justify-center items-center w-full h-full">
      <div className="mx-auto mb-20 w-full max-w-md">
        <EmptyCap
          key={theme + "empty-shared-cap"}
          className="max-w-[300px] w-full mx-auto md:max-w-[600px] h-[250px]"
        />
      </div>
      <div className="text-center pb-[30px]">
        <p className="mb-3 text-xl font-semibold text-gray-12">
          No shared Caps yet!
        </p>
        <p className="max-w-md text-md text-gray-10">
          There are no Caps shared with {organizationName} yet. Ask your team
          members to share their Caps with this {type}.
        </p>
      </div>
    </div>
  );
};
