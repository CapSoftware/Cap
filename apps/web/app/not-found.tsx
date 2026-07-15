export default function NotFound() {
	return (
		<div className="wrapper flex flex-col items-center justify-center h-screen text-center">
			<h1 className="text-5xl md:text-6xl font-medium">404</h1>
			<p className="text-3xl md:text-4xl mb-2">抱歉，找不到此页面</p>
			<p className="text-gray-400 text-lg md:text-xl">
				如果你认为这是系统错误，请联系 Cap 团队：{" "}
				<a
					href="mailto:hello@cap.so"
					className="font-medium text-gray-500 text-lg md:text-xl hover:underline"
				>
					hello@cap.so
				</a>
			</p>
		</div>
	);
}
