// use std::sync::{Arc, Mutex, RwLock};

// use cap_media::feeds::{CameraFeed, DeviceOrModelID, SetupCameraError, SwitchCameraError};
// use cap_project::Camera;
// use futures::TryFutureExt;
// use kameo::{Actor, prelude::*};
// use tokio::task::JoinHandle;
// use tokio_util::sync::CancellationToken;
// use tracing::error;

// #[derive(Actor, Default)]
// pub enum CameraFeedActor {
//     #[default]
//     Detached,
//     Initializing {
//         handle: JoinHandle<()>,
//     },
//     Attached {
//         feed: CameraFeed,
//     },
//     SwitchingCamera {
//         cancel: CancellationToken,
//     },
// }

// #[derive(Reply)]
// struct AsReply<T: Send + Sync + 'static>(T);

// struct GetCameraFeed;
// impl Message<GetCameraFeed> for CameraFeedActor {
//     type Reply = AsReply<CameraFeed>;

//     async fn handle(
//         &mut self,
//         _: GetCameraFeed,
//         _ctx: &mut Context<Self, Self::Reply>,
//     ) -> Self::Reply {
//         match self {
//             CameraFeedActor::Detached => todo!(),
//             CameraFeedActor::Initializing => todo!(),
//             CameraFeedActor::Attached { feed } => AsReply((*feed).clone()),
//         }
//     }
// }

// struct SetCameraInput {
//     id: DeviceOrModelID,
// }
// impl Message<SetCameraInput> for CameraFeedActor {
//     type Reply = ();

//     async fn handle(
//         &mut self,
//         SetCameraInput { id }: SetCameraInput,
//         ctx: &mut Context<Self, Self::Reply>,
//     ) -> Self::Reply {
//         let actor = ctx.actor_ref();

//         match self {
//             CameraFeedActor::Detached | CameraFeedActor::Initializing { .. } => {
//                 if let CameraFeedActor::Initializing { handle } = self {
//                     handle.abort();
//                 }

//                 *self = CameraFeedActor::Initializing {
//                     handle: tokio::spawn(async move {
//                         actor
//                             .ask(CameraFeedInitializedResult(CameraFeed::init(id).await))
//                             .await;
//                     }),
//                 }
//             }
//             CameraFeedActor::Attached { .. } | CameraFeedActor::SwitchingCamera { .. } => {
//                 // let (CameraFeedActor::Attached { mut feed }
//                 // | CameraFeedActor::SwitchingCamera { mut feed, .. }) =
//                 //     std::mem::replace(self, CameraFeedActor::Detached)
//                 // else {
//                 //     unreachable!();
//                 // };
//                 // let fut = feed.switch_cameras(id);

//                 // *self = CameraFeedActor::SwitchingCamera {
//                 //     feed: feed,
//                 //     handle: tokio::spawn(async move {
//                 //         actor.ask(CameraFeedSwitchResult(fut.await)).await;
//                 //     }),
//                 // }
//             } //  => {

//               // }
//         }
//     }
// }

// struct CameraFeedInitializedResult(Result<CameraFeed, SetupCameraError>);
// impl Message<CameraFeedInitializedResult> for CameraFeedActor {
//     type Reply = ();

//     async fn handle(
//         &mut self,
//         result: CameraFeedInitializedResult,
//         _ctx: &mut Context<Self, Self::Reply>,
//     ) -> Self::Reply {
//         match result.0 {
//             Ok(feed) => {
//                 *self = CameraFeedActor::Attached { feed };
//             }
//             Err(err) => {
//                 error!("Failed to initialize camera feed: {err}");
//                 *self = CameraFeedActor::Detached;
//             }
//         }
//     }
// }

// struct CameraFeedSwitchResult(Result<(), SwitchCameraError>);
// impl Message<CameraFeedSwitchResult> for CameraFeedActor {
//     type Reply = ();

//     async fn handle(
//         &mut self,
//         result: CameraFeedSwitchResult,
//         _ctx: &mut Context<Self, Self::Reply>,
//     ) -> Self::Reply {
//         if let Err(err) = result.0 {
//             error!("Failed to switch camera feed: {err}");
//         }

//         let Self::SwitchingCamera { feed, .. } = std::mem::replace(self, CameraFeedActor::Detached)
//         else {
//             unreachable!();
//         };
//         *self = CameraFeedActor::Attached { feed };
//     }
// }

// struct StopCameraFeed;
// impl Message<StopCameraFeed> for CameraFeedActor {
//     type Reply = ();

//     async fn handle(
//         &mut self,
//         _: StopCameraFeed,
//         _ctx: &mut Context<Self, Self::Reply>,
//     ) -> Self::Reply {
//         match self {
//             CameraFeedActor::Detached => {}
//             CameraFeedActor::Initializing => todo!(),
//             CameraFeedActor::Attached { feed } => {
//                 *self = CameraFeedActor::Detached;
//             }
//         }
//     }
// }
