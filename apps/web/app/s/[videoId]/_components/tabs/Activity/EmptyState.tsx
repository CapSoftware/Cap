import { LoadingSpinner } from "@cap/ui";

const EmptyState = () => (
	<div className="flex flex-col justify-center items-center p-8 h-full text-center animate-in fade-in">
		<div className="space-y-2 text-gray-300">
			<LoadingSpinner />
			<h3 className="text-sm font-medium text-gray-12">No comments yet</h3>
			<p className="text-sm text-gray-10">
				Be the first to share your thoughts!
			</p>
		</div>
	</div>
);

export default EmptyState;
