import moment from "moment";

interface ShareVideoProps {
  title: string;
  created: string;
}

export const ShareVideo = ({ data }: { data: ShareVideoProps }) => {
  return (
    <div>
      <div className="w-full aspect-video mx-auto bg-gray-100 rounded-xl mb-4"></div>
      <h1 className="text-2xl">{data.title}</h1>
      <p className="text-base text-gray-500">
        {moment(data.created).fromNow()}
      </p>
    </div>
  );
};
