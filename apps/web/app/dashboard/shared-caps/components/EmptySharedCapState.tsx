interface EmptySharedCapStateProps {
  spaceName: string;
}

export const EmptySharedCapState: React.FC<EmptySharedCapStateProps> = ({
  spaceName,
}) => {
  return (
    <div className="flex flex-col flex-1 justify-center items-center w-full h-full">
      <div className="mx-auto w-full max-w-md">
        <img
          className="w-full max-w-[400px] h-auto"
          src="/illustrations/person-microphone.svg"
          alt="Person using microphone"
        />
      </div>
      <div className="text-center pb-[30px]">
        <p className="mb-3 text-xl font-semibold text-gray-12">
          No shared Caps yet!
        </p>
        <p className="max-w-md text-md text-gray-10">
          There are no Caps shared with {spaceName} yet. Ask your team members
          to share their Caps with this space.
        </p>
      </div>
    </div>
  );
};
