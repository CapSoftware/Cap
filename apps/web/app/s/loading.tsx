"use client";

export default function Loading() {
  return (
    <div className="flex flex-col h-screen max-w-6xl mx-auto px-4">
      <div className="flex-shrink-0 py-4">
        {/* ShareHeader placeholder */}
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center space-x-3">
              <div className="w-48 h-6 bg-gray-200 rounded animate-pulse"></div>
              <div className="w-8 h-6 bg-gray-200 rounded-lg animate-pulse"></div>
            </div>
            <div className="mt-2 w-20 h-4 bg-gray-200 rounded-lg animate-pulse"></div>
          </div>
        </div>
      </div>
      <div className="md:flex-grow md:flex md:flex-col min-h-0">
        <div className="flex-grow relative">
          <div className="md:absolute inset-0">
            {/* ShareVideo placeholder */}
            <div className="relative w-full h-full overflow-hidden shadow-lg rounded-lg">
              <div
                className="relative block w-full h-full rounded-lg bg-gray-200 animate-pulse"
                style={{ paddingBottom: "56.25%" }}
              >
                <div className="absolute inset-0 bg-gray-300 animate-pulse"></div>
              </div>
              {/* Video controls placeholder */}
              <div className="absolute bottom-0 w-full bg-gray-800 bg-opacity-50">
                <div className="flex items-center justify-between px-4 py-2">
                  <div className="flex items-center space-x-3">
                    <div className="w-8 h-8 bg-gray-400 rounded-full animate-pulse"></div>
                    <div className="w-24 h-4 bg-gray-400 rounded animate-pulse"></div>
                  </div>
                  <div className="flex space-x-2">
                    <div className="w-8 h-8 bg-gray-400 rounded-full animate-pulse"></div>
                    <div className="w-8 h-8 bg-gray-400 rounded-full animate-pulse"></div>
                    <div className="w-8 h-8 bg-gray-400 rounded-full animate-pulse"></div>
                    <div className="w-8 h-8 bg-gray-400 rounded-full animate-pulse"></div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div className="flex-shrink-0 py-4">
          {/* Toolbar placeholder */}
          <div className="flex justify-center">
            <div className="w-64 h-10 bg-gray-200 rounded animate-pulse"></div>
          </div>
        </div>
      </div>
    </div>
  );
}
