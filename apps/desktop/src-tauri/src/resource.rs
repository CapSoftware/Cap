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
