// i've got an idea

use std::{future::Future, sync::Arc};

use futures::pin_mut;
use tokio::sync::{watch, Mutex};

#[derive(Clone)]
pub struct Resource<T>(Arc<ResourceInner<T>>);

struct ResourceInner<T> {
    fetcher: Box<dyn Fn() -> Box<dyn Future<Output = T>>>,
    value: watch::Receiver<Option<T>>,
    value_sender: watch::Sender<Option<T>>,
    current_fetch: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl<T> Resource<T> {
    fn new(fetcher: impl Fn() -> Box<dyn Future<Output = T> + 'static> + 'static) -> Self {
        let (tx, rx) = watch::channel(None);
        let value = tx.clone();

        let this = Self(Arc::new(ResourceInner {
            fetcher: Box::new(fetcher),
            value: rx,
            value_sender: tx,
            current_fetch: Mutex::new(None),
        }));

        tokio::spawn({
            let this = this.clone();
            async move { this.refetch().await }
        });

        this
    }

    pub async fn refetch(&self) -> T {
        let this = self.clone();

        tokio::spawn(async move {
            let fut = this.0.fetcher();
            pin_mut!(fut);
            let value = fut.await;
            tx.send(Some(value)).unwrap();
        });
    }

    pub fn get(&self) -> Option<&T> {
        self.value.borrow().as_ref()
    }
}

// UI labels and constants for export dialogs.
pub mod export_ui {
    /// Title for the export dialog.
    pub const EXPORT_DIALOG_TITLE: &str = "Export Options";

    /// Label for the file type selection dropdown.
    pub const FILE_TYPE_LABEL: &str = "Select Export Format:";

    /// Option value for MP4.
    pub const MP4_OPTION: &str = "MP4";

    /// Option value for GIF.
    pub const GIF_OPTION: &str = "GIF";

    /// Label for GIF FPS input.
    pub const GIF_FPS_LABEL: &str = "Enter desired FPS (default is 15):";

    /// Label for the high quality GIF toggle.
    pub const GIF_QUALITY_LABEL: &str = "High Quality GIF:";
}
