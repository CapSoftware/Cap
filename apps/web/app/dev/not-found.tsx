export default function DeveloperVideoNotFound() {
	return (
		<div className="grid min-h-dvh place-items-center px-5 text-center">
			<div className="max-w-[420px]">
				<h1 className="m-0 text-[15px] font-medium leading-[1.3] tracking-[-0.01em] text-[#E8ECF4]">
					Video not found
				</h1>
				<p className="m-0 mt-1.5 text-pretty text-[13.5px] leading-[1.55] text-[rgba(232,236,244,0.62)]">
					This video does not exist or has been deleted.
				</p>
			</div>
		</div>
	);
}
