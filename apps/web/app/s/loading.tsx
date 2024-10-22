"use client";

export default function Loading() {
  return (
    <div className="wrapper py-8">
      <div className="space-y-6">
        {/* Header placeholder */}
        <div className="md:flex md:items-center md:justify-between space-x-0 md:space-x-6 mb-6">
          <div className="md:flex items-center md:justify-between md:space-x-6">
            <div className="mb-3 md:mb-0">
              <div className="flex items-center space-x-3">
                <div className="w-48 h-8 bg-gray-200 rounded animate-pulse"></div>
                <div className="w-8 h-8 bg-gray-200 rounded-lg animate-pulse"></div>
              </div>
              <div className="w-24 h-4 bg-gray-200 rounded mt-2 animate-pulse"></div>
            </div>
          </div>
          <div className="flex items-center space-x-2">
            <div className="w-32 h-10 bg-gray-200 rounded animate-pulse"></div>
            <div className="w-32 h-10 bg-gray-200 rounded animate-pulse"></div>
          </div>
        </div>

        {/* Video placeholder */}
        <div className="relative flex h-full w-full overflow-hidden shadow-lg rounded-lg">
          <div
            className="relative block w-full h-full rounded-lg bg-gray-200 animate-pulse"
            style={{ paddingBottom: "min(806px, 56.25%)" }}
          >
            <div className="absolute inset-0 bg-gray-300 animate-pulse"></div>
          </div>
          {/* Controls bar placeholder */}
          <div className="absolute bottom-0 w-full h-16 bg-gray-300 animate-pulse">
            {/* Seek bar placeholder */}
            <div className="absolute top-0 left-0 right-0 h-2 bg-gray-400"></div>
            {/* Controls placeholder */}
            <div className="flex justify-between items-center h-full px-4">
              <div className="w-24 h-8 bg-gray-400 rounded"></div>
              <div className="flex space-x-2">
                <div className="w-8 h-8 bg-gray-400 rounded"></div>
                <div className="w-8 h-8 bg-gray-400 rounded"></div>
                <div className="w-8 h-8 bg-gray-400 rounded"></div>
              </div>
            </div>
          </div>
        </div>

        {/* Toolbar placeholder */}
        <div className="flex justify-center mb-4">
          <div className="w-64 h-10 bg-gray-200 rounded animate-pulse"></div>
        </div>

        {/* Logo placeholder */}
        <div className="flex justify-center items-center">
          <div className="w-48 h-12 bg-gray-200 rounded-full animate-pulse"></div>
        </div>
      </div>
    </div>
  );
}
