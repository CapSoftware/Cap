import { faPlus } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Button } from "@inflight/ui";
import { useRive } from "@rive-app/react-canvas";
import { useTheme } from "../../../Contexts";

interface EmptySharedCapStateProps {
	organizationName: string;
	type?: "space" | "organization";
	spaceData?: {
		id: string;
		name: string;
		organizationId: string;
		createdById: string;
	};
	currentUserId?: string;
	onAddVideos?: () => void;
}

export const EmptySharedCapState: React.FC<EmptySharedCapStateProps> = ({
	organizationName,
	type = "organization",
	spaceData,
	currentUserId,
	onAddVideos,
}) => {
	const { theme } = useTheme();
	const { RiveComponent: EmptyCap } = useRive({
		src: "/rive/main.riv",
		artboard: theme === "light" ? "emptyshared" : "darkemptyshared",
		autoplay: true,
	});

	const isSpaceOwner = spaceData?.createdById === currentUserId;
	const showAddButton =
		(type === "space" && isSpaceOwner && onAddVideos) ||
		(type === "organization" && onAddVideos);

	return (
		<div className="flex flex-col flex-1 justify-center items-center w-full h-full">
			<div className="mx-auto mb-20 w-full max-w-md">
				<EmptyCap
					key={`${theme}empty-shared-cap`}
					className="max-w-[300px] w-full mx-auto md:max-w-[600px] h-[250px]"
				/>
			</div>
			<div className="text-center pb-[30px]">
				<p className="mb-3 text-xl font-semibold text-gray-12">
					{type === "space"
						? "Start sharing videos to this Space"
						: "No shared Caps yet!"}
				</p>
				<p className="mb-6 max-w-md text-md text-gray-10">
					{type === "space"
						? "Add videos directly here in this Space, or add videos from the My Caps page."
						: `There are no Caps shared with ${organizationName} yet. Ask your team members to share their Caps with this ${type}.`}
				</p>
				{showAddButton && (
					<Button
						onClick={onAddVideos}
						variant="dark"
						size="lg"
						className="flex gap-2 items-center mx-auto"
					>
						<FontAwesomeIcon icon={faPlus} className="size-3.5" />
						Add videos to {type === "space" ? "Space" : "Organization"}
					</Button>
				)}
			</div>
		</div>
	);
};
