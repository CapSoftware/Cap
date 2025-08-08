import { Notification, NotificationType } from "./types";

export const mockNotifications: Notification[] = [
  {
    id: "1",
    type: "recording",
    user: {
      name: "Wayne",
      avatar:
        "https://images.pexels.com/photos/771742/pexels-photo-771742.jpeg?auto=compress&cs=tinysrgb&w=1260&h=750&dpr=2",
      hasUnread: true,
    },
    content: "shared a new recording",
    time: "3 mins ago",
  },
  {
    id: "2",
    type: "comment",
    user: {
      name: "James",
      avatar:
        "https://images.pexels.com/photos/1040880/pexels-photo-1040880.jpeg?auto=compress&cs=tinysrgb&w=1260&h=750&dpr=2",
      hasUnread: true,
    },
    content: "commented on your video",
    time: "12 mins ago",
    additionalText:
      "This is looking awesome, goodjob and i'm looking forward to seeing more.",
  },
  {
    id: "3",
    type: "view",
    user: {
      name: "Jasmin",
      avatar: "",
      hasUnread: true,
    },
    content: "viewed your video",
    time: "20 mins ago",
  },
  {
    id: "4",
    type: "reaction",
    user: {
      name: "Jasmin",
      avatar: "",
      hasUnread: true,
    },
    content: "reacted to your video",
    time: "25 mins ago",
  },
];
