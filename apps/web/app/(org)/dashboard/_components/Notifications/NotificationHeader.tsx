import { faCheckDouble } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { toast } from "sonner";
import { markAsRead } from "@/actions/notifications/mark-as-read";

export const NotificationHeader = () => {
	const queryClient = useQueryClient();
	const mutation = useMutation({
		mutationFn: () => markAsRead(),
		onSuccess: () => {
			toast.success("Notifications marked as read");
			queryClient.invalidateQueries({
				queryKey: ["notifications"],
			});
		},
		onError: (error) => {
			console.error("Error marking notifications as read:", error);
			toast.error("Failed to mark notifications as read");
		},
	});

	return (
		<div className="flex justify-between items-center px-6 py-3 rounded-t-xl border bg-gray-3 border-gray-4">
			<p className="text-md text-gray-12">Notifications</p>
			<div
				onClick={() => mutation.mutate()}
				className={clsx(
					"flex gap-1 items-center transition-opacity duration-200 cursor-pointer hover:opacity-70",
					mutation.isPending ? "opacity-50 cursor-not-allowed" : "",
				)}
			>
				<FontAwesomeIcon
					icon={faCheckDouble}
					className="text-blue-9 size-2.5"
				/>
				<p className="text-[13px] text-blue-9">Mark all as read</p>
			</div>
		</div>
	);
};
