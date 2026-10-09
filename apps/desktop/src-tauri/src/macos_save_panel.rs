use block2::RcBlock;
use objc2::rc::Retained;
use objc2::{ClassType, MainThreadMarker, msg_send};
use objc2_app_kit::{NSApplication, NSModalResponseCancel, NSModalResponseOK, NSSavePanel};
use objc2_foundation::{NSArray, NSString};
use std::cell::RefCell;
use std::path::PathBuf;

fn response_result(response: isize, path: Option<PathBuf>) -> Result<Option<PathBuf>, String> {
    match response {
        value if value == NSModalResponseCancel => Ok(None),
        value if value == NSModalResponseOK => path
            .map(Some)
            .ok_or_else(|| "The save dialog did not return a file path".to_string()),
        _ => Err("The save dialog could not be displayed".to_string()),
    }
}

pub fn show(
    file_name: &str,
    extensions: &[&str],
    completion: impl FnOnce(Result<Option<PathBuf>, String>) + 'static,
) {
    let Some(mtm) = MainThreadMarker::new() else {
        completion(Err(
            "The save dialog must run on the main thread".to_string()
        ));
        return;
    };

    // AppKit can return nil here even when the bundle signature is valid (Cap #2163).
    let panel: Option<Retained<NSSavePanel>> =
        unsafe { msg_send![NSSavePanel::class(), savePanel] };
    let Some(panel) = panel else {
        completion(Err("The save dialog is unavailable".to_string()));
        return;
    };

    unsafe {
        panel.setCanCreateDirectories(true);
        panel.setTitle(Some(&NSString::from_str("Save File")));
        panel.setNameFieldStringValue(&NSString::from_str(file_name));
        if !extensions.is_empty() {
            let extensions: Vec<_> = extensions
                .iter()
                .map(|extension| NSString::from_str(extension))
                .collect();
            let extensions = NSArray::from_retained_slice(&extensions);
            let _: () = msg_send![&*panel, setAllowedFileTypes: &*extensions];
        }
    }

    let completion = RefCell::new(Some(completion));
    let callback_panel = panel.clone();
    let callback = RcBlock::new(move |response: isize| {
        let Some(completion) = completion.borrow_mut().take() else {
            return;
        };
        let path = if response == NSModalResponseOK {
            unsafe { callback_panel.URL() }
                .and_then(|url| unsafe { url.path() })
                .map(|path| PathBuf::from(path.to_string()))
        } else {
            None
        };
        callback_panel.orderOut(None);
        completion(response_result(response, path));
    });
    let app = NSApplication::sharedApplication(mtm);
    let parent = app.keyWindow().or_else(|| unsafe { app.mainWindow() });
    unsafe {
        if let Some(parent) = parent {
            panel.beginSheetModalForWindow_completionHandler(&parent, &callback);
        } else {
            panel.beginWithCompletionHandler(&callback);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use objc2_app_kit::NSModalResponseAbort;

    #[test]
    fn explicit_cancel_does_not_become_a_dialog_failure() {
        assert_eq!(response_result(NSModalResponseCancel, None), Ok(None));
    }

    #[test]
    fn native_failure_is_distinct_from_explicit_cancel() {
        assert!(response_result(NSModalResponseAbort, None).is_err());
    }

    #[test]
    fn accepted_dialog_requires_a_destination() {
        assert!(response_result(NSModalResponseOK, None).is_err());
    }

    #[test]
    fn accepted_dialog_preserves_the_selected_destination() {
        let path = PathBuf::from("/tmp/My Export.mov");
        assert_eq!(
            response_result(NSModalResponseOK, Some(path.clone())),
            Ok(Some(path))
        );
    }
}
