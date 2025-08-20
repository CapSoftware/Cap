use cidre::{arc, cg, ns, sc};
use objc2::{MainThreadMarker, rc::Retained};
use objc2_app_kit::NSScreen;
use objc2_foundation::{NSArray, NSNumber, ns_string};

#[derive(Clone, Debug)]
pub struct Display {
    inner: arc::R<sc::Display>,
    name: String,
}

impl Display {
    pub fn name(&self) -> &String {
        &self.name
    }

    pub fn inner(&self) -> &sc::Display {
        self.inner.as_ref()
    }

    /// Logical width of the display in pixels
    pub fn width(&self) -> usize {
        self.inner().width() as usize
    }

    /// Logical height of the display in pixels
    pub fn height(&self) -> usize {
        self.inner().height() as usize
    }

    pub async fn list() -> Result<Vec<Self>, arc::R<ns::Error>> {
        let content = sc::ShareableContent::current().await?;

        // SAFETY: NSScreen::screens is callable from any thread
        let ns_screens = NSScreen::screens(unsafe { MainThreadMarker::new_unchecked() });

        let displays = content
            .displays()
            .iter()
            .filter_map(|display| {
                let id = display.display_id();

                let ns_screen = ns_screens.iter().find(|ns_screen| {
                    ns_screen
                        .deviceDescription()
                        .objectForKey(ns_string!("NSScreenNumber"))
                        .and_then(|v| v.downcast_ref::<NSNumber>().map(|v| v.as_u32()))
                        .map(|v| v == id.0)
                        .unwrap_or(false)
                })?;

                let name = unsafe { ns_screen.localizedName() }.to_string();

                Some(Self {
                    inner: display.retained(),
                    name,
                })
            })
            .collect::<Vec<_>>();

        Ok(displays)
    }

    pub async fn primary() -> Option<Self> {
        let id = cg::DirectDisplayId::main();

        let content = sc::ShareableContent::current().await.ok()?;

        let inner = content
            .displays()
            .iter()
            .find(|d| d.display_id() == id)?
            .retained();

        Some(Self {
            inner,
            name: get_display_name(id, None)?,
        })
    }

    pub async fn from_id(id: cg::DirectDisplayId) -> Option<Self> {
        let content = sc::ShareableContent::current().await.ok()?;

        let inner = content
            .displays()
            .iter()
            .find(|d| d.display_id() == id)?
            .retained();

        Some(Self {
            inner,
            name: get_display_name(id, None)?,
        })
    }

    pub fn as_content_filter(&self) -> arc::R<sc::ContentFilter> {
        self.as_content_filter_excluding_windows(vec![])
    }

    pub fn as_content_filter_excluding_windows(
        &self,
        windows: Vec<Window>,
    ) -> arc::R<sc::ContentFilter> {
        let excluded_windows = ns::Array::from_slice_retained(
            windows
                .into_iter()
                .map(|win| win.inner)
                .collect::<Vec<_>>()
                .as_slice(),
        );

        sc::ContentFilter::with_display_excluding_windows(&self.inner, &excluded_windows)
    }
}

fn get_display_name(
    id: cg::DirectDisplayId,
    screens: Option<Retained<NSArray<NSScreen>>>,
) -> Option<String> {
    // SAFETY: NSScreen::screens is callable from any thread
    let screens =
        screens.unwrap_or_else(|| NSScreen::screens(unsafe { MainThreadMarker::new_unchecked() }));

    let ns_screen = screens.iter().find(|ns_screen| {
        ns_screen
            .deviceDescription()
            .objectForKey(ns_string!("NSScreenNumber"))
            .and_then(|v| v.downcast_ref::<NSNumber>().map(|v| v.as_u32()))
            .map(|v| v == id.0)
            .unwrap_or(false)
    })?;

    Some(unsafe { ns_screen.localizedName() }.to_string())
}

#[derive(Clone, Debug)]
pub struct Window {
    inner: arc::R<sc::Window>,
    title: Option<String>,
}

impl Window {
    pub fn title(&self) -> Option<&String> {
        self.title.as_ref()
    }

    pub fn inner(&self) -> &sc::Window {
        self.inner.as_ref()
    }

    /// Logical width of the window in pixels.
    pub fn width(&self) -> usize {
        self.inner.frame().size.width as usize
    }

    /// Logical height of the window in pixels.
    pub fn height(&self) -> usize {
        self.inner.frame().size.height as usize
    }

    fn from_sc(window: &sc::Window) -> Self {
        Self {
            inner: window.retained(),
            title: window.title().map(|s| s.to_string()),
        }
    }

    pub async fn list() -> Result<Vec<Self>, arc::R<ns::Error>> {
        let content = sc::ShareableContent::current().await?;

        let windows = content
            .windows()
            .iter()
            .map(Self::from_sc)
            .collect::<Vec<_>>();

        Ok(windows)
    }

    pub fn as_content_filter(&self) -> arc::R<sc::ContentFilter> {
        sc::ContentFilter::with_desktop_independent_window(self.inner.as_ref())
    }
}

#[cfg(debug_assertions)]
mod test {
    use super::*;

    fn assert_send<T: Send>() {}
    fn assert_send_val<T: Send>(_: T) {}

    #[allow(dead_code)]
    fn ensure_send() {
        assert_send::<Display>();
        assert_send_val(Display::list());

        assert_send::<Window>();
        assert_send_val(Window::list());
    }
}
