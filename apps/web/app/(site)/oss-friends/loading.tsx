export default function Loading() {
  return (
    <div className="mt-[120px]">
      <div className="relative z-10 px-5 pt-24 pb-36 w-full">
        <div className="mx-auto text-center wrapper wrapper-sm mb-16">
          <div className="animate-pulse">
            <div className="h-16 bg-gray-200 rounded-lg mb-4 max-w-md mx-auto"></div>
            <div className="h-6 bg-gray-200 rounded-lg mb-2 max-w-2xl mx-auto"></div>
            <div className="h-6 bg-gray-200 rounded-lg mb-2 max-w-xl mx-auto"></div>
            <div className="h-6 bg-gray-200 rounded-lg max-w-lg mx-auto"></div>
          </div>
        </div>

        <div className="max-w-6xl mx-auto">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {Array.from({ length: 9 }).map((_, index) => (
              <div
                key={index}
                className="animate-pulse bg-white border border-gray-200 rounded-lg p-6"
              >
                <div className="flex items-start justify-between mb-3">
                  <div className="h-6 bg-gray-200 rounded flex-1 mr-2"></div>
                  <div className="w-5 h-5 bg-gray-200 rounded"></div>
                </div>
                <div className="space-y-2">
                  <div className="h-4 bg-gray-200 rounded"></div>
                  <div className="h-4 bg-gray-200 rounded w-3/4"></div>
                  <div className="h-4 bg-gray-200 rounded w-1/2"></div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
