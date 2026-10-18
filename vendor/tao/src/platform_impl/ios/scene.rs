// Copyright 2021-2025 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0

use objc2::{define_class, rc::Retained, MainThreadMarker, MainThreadOnly};
use objc2_foundation::{
  NSBundle, NSError, NSObject, NSObjectProtocol, NSSet, NSString, NSUserActivity,
};
use objc2_ui_kit::{
  UIApplication, UIOpenURLContext, UIScene, UISceneConnectionOptions, UISceneDelegate,
  UISceneSession, UISceneWindowingControlStyle, UIWindowScene, UIWindowSceneDelegate,
};

use crate::{
  event::{Event, WindowEvent},
  platform_impl::platform::{app_state, event_loop::EventWrapper},
  window::WindowId as RootWindowId,
};

// true when the app enabled `UIApplicationSupportsMultipleScenes` in its Info.plist
// and the device allows it to display multiple scenes
// https://developer.apple.com/documentation/uikit/uiapplication/supportsmultiplescenes?language=objc
pub unsafe fn app_supports_multiple_scenes() -> bool {
  let mtm = MainThreadMarker::new().unwrap();
  let application = UIApplication::sharedApplication(mtm);
  application.supportsMultipleScenes()
}

// check whether the app adopted the scene lifecycle by declaring a
// `UIApplicationSceneManifest` in its Info.plist
//
// such apps get their windows and their lifecycle callbacks from a `UISceneDelegate`
// instead of the application delegate, so a `UIWindow` is only visible once it is
// attached to a scene
// https://developer.apple.com/documentation/bundleresources/information-property-list/uiapplicationscenemanifest
pub unsafe fn scene_lifecycle_enabled() -> bool {
  let bundle = NSBundle::mainBundle();
  let Some(info) = bundle.infoDictionary() else {
    return false;
  };

  let key = NSString::from_str("UIApplicationSceneManifest");
  (*info).objectForKey(&key).is_some()
}

unsafe fn handle_scene_window_events(scene: &UIScene, event: impl Fn() -> WindowEvent<'static>) {
  if let Some(window_scene) = scene.downcast_ref::<UIWindowScene>() {
    let windows = window_scene.windows();

    if windows.is_empty() {
      log::debug!("scene has no windows; no window events were emitted");
    }

    for window in windows {
      app_state::handle_nonuser_event(EventWrapper::StaticEvent(Event::WindowEvent {
        window_id: RootWindowId(window.into()),
        event: event(),
      }));
    }
  }
}

define_class!(
  #[unsafe(super(NSObject))]
  #[name = "TaoSceneDelegate"]
  #[thread_kind = MainThreadOnly]
  pub struct TaoSceneDelegate;

  unsafe impl NSObjectProtocol for TaoSceneDelegate {}

  #[allow(non_snake_case)]
  unsafe impl UISceneDelegate for TaoSceneDelegate {
    #[unsafe(method(scene:willConnectToSession:options:))]
    fn scene_willConnectToSession_options(
      &self,
      scene: &UIScene,
      _session: &UISceneSession,
      connection_options: &UISceneConnectionOptions,
    ) {
      unsafe {
        app_state::connect_scene(scene, connection_options);
      }
    }

    // iOS may disconnect a scene because the user closed it, or because
    // the system discarded a backgrounded scene to free resources. A
    // restored scene goes through `scene:willConnectToSession:` again
    // and gets a new `UIWindow` and `WindowId`.
    #[unsafe(method(sceneDidDisconnect:))]
    fn sceneDidDisconnect(&self, scene: &UIScene) {
      unsafe {
        if app_state::is_terminated() {
          log::debug!("ignoring `sceneDidDisconnect` after application termination");
          return;
        }

        handle_scene_window_events(scene, || WindowEvent::Destroyed);
      }
    }

    #[unsafe(method(sceneDidBecomeActive:))]
    fn sceneDidBecomeActive(&self, scene: &UIScene) {
      unsafe {
        handle_scene_window_events(scene, || WindowEvent::Focused(true));
      }
    }

    #[unsafe(method(sceneWillResignActive:))]
    fn sceneWillResignActive(&self, scene: &UIScene) {
      unsafe {
        handle_scene_window_events(scene, || WindowEvent::Focused(false));
        handle_scene_window_events(scene, || WindowEvent::Suspended);
      }
    }

    #[unsafe(method(sceneWillEnterForeground:))]
    fn sceneWillEnterForeground(&self, scene: &UIScene) {
      unsafe {
        handle_scene_window_events(scene, || WindowEvent::Resumed);
      }
    }

    #[unsafe(method(sceneDidEnterBackground:))]
    fn sceneDidEnterBackground(&self, _scene: &UIScene) {}

    #[unsafe(method(scene:openURLContexts:))]
    fn scene_openURLContexts(&self, _scene: &UIScene, url_contexts: &NSSet<UIOpenURLContext>) {
      unsafe {
        let urls: Vec<url::Url> = url_contexts
          .iter()
          .filter_map(|ctx| {
            ctx.URL().absoluteString().and_then(|url| {
              let url = url.to_string();
              url
                .parse()
                .map_err(|e| {
                  log::error!("failed to parse URL {url} from scene:openURLContexts: {e}");
                  e
                })
                .ok()
            })
          })
          .collect();
        if !urls.is_empty() {
          app_state::handle_nonuser_event(EventWrapper::StaticEvent(Event::Opened { urls }));
        }
      }
    }

    #[unsafe(method(stateRestorationActivityForScene:))]
    fn stateRestorationActivityForScene(
      &self,
      _scene: &UIScene,
    ) -> Option<std::ptr::NonNull<NSUserActivity>> {
      None
    }

    #[unsafe(method(scene:restoreInteractionStateWithUserActivity:))]
    fn scene_restoreInteractionStateWithUserActivity(
      &self,
      _scene: &UIScene,
      _state_restoration_activity: &NSUserActivity,
    ) {
    }

    #[unsafe(method(scene:willContinueUserActivityWithType:))]
    fn scene_willContinueUserActivityWithType(
      &self,
      _scene: &UIScene,
      _user_activity_type: &NSString,
    ) {
    }

    #[unsafe(method(scene:continueUserActivity:))]
    fn scene_continueUserActivity(&self, _scene: &UIScene, user_activity: &NSUserActivity) {
      unsafe {
        // universal app links
        if let Some(url) = user_activity
          .webpageURL()
          .and_then(|url| url.absoluteString())
        {
          let url = url.to_string().parse::<url::Url>().unwrap();
          app_state::handle_nonuser_event(EventWrapper::StaticEvent(Event::Opened {
            urls: vec![url],
          }));
        }
      }
    }

    #[unsafe(method(scene:didFailToContinueUserActivityWithType:error:))]
    fn scene_didFailToContinueUserActivityWithType_error(
      &self,
      _scene: &UIScene,
      _user_activity_type: &NSString,
      _error: &NSError,
    ) {
    }

    #[unsafe(method(scene:didUpdateUserActivity:))]
    fn scene_didUpdateUserActivity(&self, _scene: &UIScene, _user_activity: &NSUserActivity) {}
  }

  #[allow(non_snake_case)]
  unsafe impl UIWindowSceneDelegate for TaoSceneDelegate {}

  // Registered from a plain `impl` because objc2 panics in debug builds when a
  // protocol-block selector is missing from the runtime protocol, and this one is
  // iOS 26+. Both paths register the same method, so iOS 26 still resolves it.
  //
  // TODO: Move back into the protocol block once objc2 0.7.0 fixes the check,
  // ref <https://github.com/madsmtm/objc2/issues/645>.
  #[allow(non_snake_case)]
  impl TaoSceneDelegate {
    #[unsafe(method_id(preferredWindowingControlStyleForScene:))]
    fn preferredWindowingControlStyleForScene(
      &self,
      _window_scene: &UIWindowScene,
    ) -> Retained<UISceneWindowingControlStyle> {
      UISceneWindowingControlStyle::minimalStyle()
    }
  }
);
