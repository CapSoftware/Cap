import { Button } from "@cap/ui";
import { faPlus } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useRive } from "@/lib/rive";
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
	canAddVideos?: boolean;
	onAddVideos?: () => void;
}

export const EmptySharedCapState: React.FC<EmptySharedCapStateProps> = ({
	organizationName,
	type = "organization",
	spaceData,
	currentUserId,
	canAddVideos,
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
		(type === "space" && (isSpaceOwner || canAddVideos) && onAddVideos) ||
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
					{type === "space" ? "开始在此空间共享视频" : "暂无共享录制"}
				</p>
				<p className="mb-6 max-w-md text-md text-gray-10">
					{type === "space"
						? "你可以直接在此空间添加视频，也可以从“我的录制”页面添加。"
						: `目前还没有与${organizationName}共享的录制。你可以邀请团队成员将录制共享给此组织。`}
				</p>
				{showAddButton && (
					<Button
						onClick={onAddVideos}
						variant="dark"
						size="lg"
						className="flex gap-2 items-center mx-auto"
					>
						<FontAwesomeIcon icon={faPlus} className="size-3.5" />
						添加视频到{type === "space" ? "空间" : "组织"}
					</Button>
				)}
			</div>
		</div>
	);
};
