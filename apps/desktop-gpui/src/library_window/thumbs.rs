//! Small decoded thumbnails for the cards and rows on screen.
//!
//! Pictures come from `library::decode_thumbnail` (the same 392x224 JPEG
//! cache the recordings panel uses), never the full-size PNG. At most `CAP`
//! stay decoded; the oldest are handed back so the window can free them from
//! the GPU atlas. Asking for a picture never decodes on the main thread: it is
//! queued and drawn when the decode lands.

use std::{
    cell::RefCell,
    collections::{HashMap, HashSet, VecDeque},
    path::{Path, PathBuf},
    sync::Arc,
};

use gpui::RenderImage;

/// Enough for several screens of the densest grid.
pub const CAP: usize = 240;

pub enum Picture {
    Ready(Arc<RenderImage>),
    Loading,
    /// The file is missing or unreadable.
    Failed,
}

#[derive(Default)]
pub struct Thumbs {
    ready: HashMap<PathBuf, Arc<RenderImage>>,
    order: VecDeque<PathBuf>,
    loading: HashSet<PathBuf>,
    failed: HashSet<PathBuf>,
    wanted: RefCell<Vec<PathBuf>>,
    evicted: Vec<Arc<RenderImage>>,
}

impl Thumbs {
    /// The decoded picture, or `None` while it loads (queued on first ask).
    #[cfg(test)]
    pub fn get(&self, path: &Path) -> Option<Arc<RenderImage>> {
        match self.picture(path) {
            Picture::Ready(image) => Some(image),
            _ => None,
        }
    }

    /// The picture, or whether it is still loading or will never come (a
    /// missing or unreadable file). Queued on first ask.
    pub fn picture(&self, path: &Path) -> Picture {
        if let Some(image) = self.ready.get(path) {
            return Picture::Ready(image.clone());
        }
        if self.failed.contains(path) {
            return Picture::Failed;
        }
        if !self.loading.contains(path) {
            self.wanted.borrow_mut().push(path.to_path_buf());
        }
        Picture::Loading
    }

    /// Paths asked for since the last call, each once, now marked loading.
    pub fn take_wanted(&mut self) -> Vec<PathBuf> {
        let mut wanted = std::mem::take(self.wanted.get_mut());
        wanted.sort();
        wanted.dedup();
        wanted.retain(|p| !self.ready.contains_key(p) && self.loading.insert(p.clone()));
        wanted
    }

    pub fn insert(&mut self, path: PathBuf, image: Arc<RenderImage>) {
        self.loading.remove(&path);
        if let Some(old) = self.ready.insert(path.clone(), image) {
            self.evicted.push(old);
        } else {
            self.order.push_back(path);
        }
        while self.ready.len() > CAP {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            if let Some(image) = self.ready.remove(&oldest) {
                self.evicted.push(image);
            }
        }
    }

    pub fn fail(&mut self, path: PathBuf) {
        self.loading.remove(&path);
        self.failed.insert(path);
    }

    /// A rescan may have rewritten files: forget failures so they are tried
    /// again (the decode cache itself checks each file's version).
    pub fn forget_failures(&mut self) {
        self.failed.clear();
    }

    /// Pictures no longer kept, for `Window::drop_image`.
    pub fn take_evicted(&mut self) -> Vec<Arc<RenderImage>> {
        std::mem::take(&mut self.evicted)
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.ready.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn image() -> Arc<RenderImage> {
        let rgba = image::RgbaImage::new(2, 2);
        crate::library::rgba_to_render_image(rgba)
    }

    #[test]
    fn asking_queues_once_and_never_twice_while_loading() {
        let mut thumbs = Thumbs::default();
        let a = PathBuf::from("/a.png");
        assert!(thumbs.get(&a).is_none());
        assert!(thumbs.get(&a).is_none());
        assert_eq!(thumbs.take_wanted(), vec![a.clone()]);
        assert!(thumbs.get(&a).is_none());
        assert!(thumbs.take_wanted().is_empty());
        thumbs.insert(a.clone(), image());
        assert!(thumbs.get(&a).is_some());
    }

    #[test]
    fn a_missing_picture_says_so_instead_of_loading_forever() {
        let mut thumbs = Thumbs::default();
        let b = PathBuf::from("/gone.png");
        assert!(matches!(thumbs.picture(&b), Picture::Loading));
        thumbs.take_wanted();
        thumbs.fail(b.clone());
        assert!(matches!(thumbs.picture(&b), Picture::Failed));
    }

    #[test]
    fn failures_are_not_retried_until_a_rescan() {
        let mut thumbs = Thumbs::default();
        let a = PathBuf::from("/broken.png");
        thumbs.get(&a);
        thumbs.take_wanted();
        thumbs.fail(a.clone());
        thumbs.get(&a);
        assert!(thumbs.take_wanted().is_empty());
        thumbs.forget_failures();
        thumbs.get(&a);
        assert_eq!(thumbs.take_wanted(), vec![a]);
    }

    #[test]
    fn memory_stays_bounded_and_evicted_pictures_are_handed_back() {
        let mut thumbs = Thumbs::default();
        for i in 0..(CAP + 50) {
            thumbs.insert(PathBuf::from(format!("/{i}.png")), image());
        }
        assert_eq!(thumbs.len(), CAP);
        assert_eq!(thumbs.take_evicted().len(), 50);
        assert!(thumbs.take_evicted().is_empty());
        // The newest are kept, the oldest went.
        assert!(
            thumbs
                .get(Path::new(&format!("/{}.png", CAP + 49)))
                .is_some()
        );
        assert!(thumbs.get(Path::new("/0.png")).is_none());
    }
}
