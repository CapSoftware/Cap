use objc2::define_class;

use objc2::rc::Retained;
use objc2_foundation::NSError;
use objc2_foundation::NSObjectProtocol;
use objc2_foundation::ns_string;
use objc2_quick_look_thumbnailing::{
    QLFileThumbnailRequest, QLThumbnailProvider, QLThumbnailReply,
};

define_class! {
    #[unsafe(super(QLThumbnailProvider))]
    struct CapThumbnailProvider;

    unsafe impl NSObjectProtocol for CapThumbnailProvider {}

    impl CapThumbnailProvider {
        #[unsafe(method(provideThumbnailForFileRequest:completionHandler:))]
        unsafe fn provide(
            &self,
            request: &QLFileThumbnailRequest,
            handler: &block2::Block<dyn Fn(*mut QLThumbnailReply, *mut NSError)>
        ) {
            let path = unsafe { request.fileURL() }.URLByAppendingPathComponent(
                ns_string!("/screenshots/display.jpg")
            );

            if let Some(path) = path {
                unsafe {
                    let reply = QLThumbnailReply::replyWithImageFileURL(&path);
                    reply.setExtensionBadge(ns_string!("Cap"));
                    handler.call((Retained::into_raw(reply), std::ptr::null_mut()));
                }
            }
        }
    }
}
