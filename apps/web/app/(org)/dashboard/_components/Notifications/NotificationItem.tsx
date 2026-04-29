import type { Notification as APINotification } from "@cap/web-api-contract";
import type { ImageUpload } from "@cap/web-domain";
import { faComment, faEye, faReply } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import clsx from "clsx";
import moment from "moment";
import Link from "next/link";
import { markAsRead } from "@/actions/notifications/mark-as-read";
import { AnimalAvatar } from "@/components/AnimalAvatar";
import { SignedImageUrl } from "@/components/SignedImageUrl";

type NotificationItemProps = {
	notification: APINotification;
	className?: string;
};

type NotificationType = APINotification["type"];

const descriptionMap: Record<NotificationType, string> = {
	comment: `commented on your video`,
	reply: `replied to your comment`,
	view: `viewed your video`,
	reaction: `reacted to your video`,
	anon_view: `viewed your video`,
};

export const NotificationItem = ({
	notification,
	className,
}: NotificationItemProps) => {
	const link = getLink(notification);

	const markAsReadHandler = async () => {
		try {
			await markAsRead(notification.id);
		} catch (error) {
			console.error("Error marking notification as read:", error);
		}
	};

	const isAnonView = notification.type === "anon_view";
	const displayName =
		notification.type === "anon_view"
			? notification.anonName
			: notification.author.name;

	return (
		<Link
			href={link}
			onClick={markAsReadHandler}
			className={clsx(
				"flex gap-3 p-4 transition-colors cursor-pointer min-h-fit border-gray-3 hover:bg-gray-2",
				className,
			)}
		>
			<div className="relative flex-shrink-0">
				{isAnonView ? (
					<AnimalAvatar
						name={displayName}
						className="relative flex-shrink-0 size-7"
					/>
				) : (
					<SignedImageUrl
						image={notification.author.avatar as ImageUpload.ImageUrl | null}
						name={displayName}
						className="relative flex-shrink-0 size-7"
						letterClass="text-sm"
					/>
				)}
				{notification.readAt === null && (
					<div className="absolute top-0 right-0 size-2.5 rounded-full bg-red-500 border-2 border-gray-1"></div>
				)}
			</div>

			<div className="flex flex-col flex-1 justify-center">
				<div className="flex gap-1 items-center">
					<span className="font-medium text-gray-12 text-[13px]">
						{displayName}
					</span>
					<span className="text-gray-10 text-[13px]">
						{descriptionMap[notification.type]}
					</span>
				</div>

				{isAnonView && notification.location && (
					<p className="text-[13px] leading-4 text-gray-11">
						{notification.location}
					</p>
				)}
				{(notification.type === "comment" || notification.type === "reply") && (
					<p className="mb-2 text-[13px] h-fit italic leading-4 text-gray-11 line-clamp-2">
						{notification.comment.content}
					</p>
				)}
				<p className="text-xs text-gray-10">
					{moment(notification.createdAt).fromNow()}
				</p>
			</div>

			<div className="flex flex-shrink-0 items-center mt-1">
				{notification.type === "comment" && (
					<FontAwesomeIcon icon={faComment} className="text-gray-10 size-4" />
				)}
				{notification.type === "reply" && (
					<FontAwesomeIcon icon={faReply} className="text-gray-10 size-4" />
				)}
				{(notification.type === "view" ||
					notification.type === "anon_view") && (
					<FontAwesomeIcon icon={faEye} className="text-gray-10 size-4" />
				)}
				{notification.type === "reaction" && (
					<span className="text-xl">{notification.comment.content}</span>
				)}
			</div>
		</Link>
	);
};

function getLink(notification: APINotification) {
	switch (notification.type) {
		case "reply":
			return `/s/${notification.videoId}/?reply=${notification.comment.id}`;
		case "comment":
		case "reaction":
			return `/s/${notification.videoId}/?comment=${notification.comment.id}`;
		case "view":
		case "anon_view":
			return `/s/${notification.videoId}`;
	}

	return `/s/${(notification as APINotification).videoId}`;
}
