export default function NotFound() {
  return (
    <div className="wrapper flex flex-col items-center justify-center h-screen text-center">
      <h1 className="text-5xl md:text-6xl font-medium">404</h1>
      <p className="text-3xl md:text-4xl mb-2">
        Oops, we couldn't find this page
      </p>
      <p className="text-gray-400 text-lg md:text-xl">
        Please contact the Cap team if this seems like a mistake:{" "}
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
