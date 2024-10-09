interface EmptySharedCapStateProps {
  spaceName: string;
}

export const EmptySharedCapState: React.FC<EmptySharedCapStateProps> = ({
  spaceName,
}) => {
  return (
    <div className="w-full flex flex-col items-center justify-center">
      <div className="w-full max-w-md mx-auto">
        <img
          className="w-full h-auto"
          src="/illustrations/person-microphone.svg"
          alt="Person using microphone"
        />
      </div>
      <div className="text-center pb-[30px]">
        <h1 className="text-2xl font-semibold mb-3">
          <span className="block">No shared Caps yet!</span>
        </h1>
        <p className="text-xl max-w-md">
          There are no Caps shared with {spaceName} yet. Ask your team members
          to share their Caps with this space.
        </p>
      </div>
    </div>
  );
};
