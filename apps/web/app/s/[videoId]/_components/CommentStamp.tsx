import { faComment } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { SignedImageUrl } from "@/components/SignedImageUrl";

interface CommentStampsProps {
	comment: {
		id: string;
		timestamp: number | null;
		type: "text" | "emoji";
		content: string;
		authorName?: string | null;
		authorImageUrlOrKey?: string | null;
	};
	adjustedPosition: string;
	handleMouseEnter: (id: string) => void;
	handleMouseLeave: () => void;
	onSeek: ((time: number) => void) | undefined;
	hoveredComment: string | null;
}

const CommentStamp: React.FC<CommentStampsProps> = ({
	comment,
	adjustedPosition,
	handleMouseEnter,
	handleMouseLeave,
	onSeek,
	hoveredComment,
}: CommentStampsProps) => {
	return (
		<div
			key={comment.id}
			className="absolute z-[50]"
			style={{
				left: adjustedPosition,
				transform: "translateX(-50%)",
				bottom: "65px",
			}}
			onMouseEnter={() => handleMouseEnter(comment.id)}
			onMouseLeave={handleMouseLeave}
		>
			{/* Comment marker */}
			<button
				type="button"
				onClick={() => {
					if (onSeek && comment.timestamp !== null) {
						onSeek(Number(comment.timestamp));
					}
				}}
				className="flex justify-center items-center bg-black rounded-full transition-all cursor-pointer size-6 hover:opacity-75"
			>
				{comment.type === "emoji" ? (
					<span className="text-sm">{comment.content}</span>
				) : (
					<FontAwesomeIcon icon={faComment} className="text-white size-3" />
				)}
			</button>

			{hoveredComment === comment.id && (
				<div className="absolute z-[50] bottom-full left-1/2 transform -translate-x-1/2 mb-2 bg-black backdrop-blur-md rounded-lg px-3 py-2 shadow-lg min-w-[200px] max-w-[300px]">
					{/* Arrow pointing down to marker */}
					<div className="absolute top-full left-1/2 w-0 h-0 border-t-4 border-r-4 border-l-4 border-black transform -translate-x-1/2 border-l-transparent border-r-transparent"></div>

					<div className="flex gap-2 items-center">
						{/* User avatar/initial */}
						{comment.authorName && (
							<SignedImageUrl
								image={comment.authorImageUrlOrKey}
								name={comment.authorName}
								type="user"
								className="size-6"
								letterClass="text-sm"
							/>
						)}
						{/* Comment content */}
						<div className="flex-1 min-w-0">
							<div className="text-sm font-medium text-white truncate">
								{comment.authorName || "Anonymous"}
							</div>
							<div className="text-xs truncate text-gray-11">
								{comment.content}
							</div>
						</div>
					</div>
				</div>
			)}
		</div>
	);
};

export default CommentStamp;
