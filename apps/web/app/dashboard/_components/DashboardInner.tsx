"use client";

export default function DashboardInner({
  children,
  title,
  emptyCondition,
  emptyComponent,
}: {
  children: React.ReactNode;
  title: string;
  emptyCondition?: boolean;
  emptyComponent?: React.ReactNode;
}) {
  return (
    <>
      <div className="h-[100vh] flex flex-col items-between gap-5 pt-5">
        <div className="h-[5vh] w-full justify-between flex items-center">
          <p className="text-xl text-gray-500">{title}</p>
        </div>
        <div className="flex flex-grow h-[90vh] bg-gray-100 rounded-tl-2xl p-8 border-[1px] border-gray-200">
          {emptyCondition ? emptyComponent : children}
        </div>
      </div>
    </>
  );
}
