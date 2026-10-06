export const CapEmbed = ({ id, title }: { id: string; title: string }) => (
	<div className="not-prose my-8 aspect-video w-full overflow-hidden rounded-xl bg-black shadow-[0_1px_2px_rgba(17,17,17,0.06),0_12px_32px_-16px_rgba(17,17,17,0.35)]">
		<iframe
			src={`https://cap.so/embed/${id}`}
			title={title}
			allow="autoplay; fullscreen; picture-in-picture"
			allowFullScreen
			loading="lazy"
			className="size-full border-0"
		/>
	</div>
);
