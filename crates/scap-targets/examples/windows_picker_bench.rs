#[cfg(windows)]
mod windows_bench {
    use scap_targets::Window;
    use scap_targets::platform::WindowListCache;
    use std::{hint::black_box, time::Instant};

    fn picker_windows(cache: &mut WindowListCache) -> Vec<(Window, String, String)> {
        cache
            .list()
            .into_iter()
            .filter_map(|window| {
                if !cache.is_valid(&window) || !cache.is_on_screen(&window) {
                    return None;
                }
                let name = window.name().filter(|name| !name.trim().is_empty())?;
                let owner = cache.owner_name(&window)?;
                if owner == "Window Server" {
                    return None;
                }
                black_box(
                    window
                        .logical_size()
                        .map(|size| (size.width() as u32, size.height() as u32)),
                );
                black_box(
                    window
                        .display_relative_logical_bounds()
                        .map(|bounds| (bounds.position().x(), bounds.position().y())),
                );
                black_box(window.display().map(|display| display.refresh_rate()));
                Some((window, name, owner))
            })
            .collect()
    }

    fn report(name: &str, samples: &[f64]) {
        let mut sorted = samples.to_vec();
        sorted.sort_by(f64::total_cmp);
        let median = (sorted[(sorted.len() - 1) / 2] + sorted[sorted.len() / 2]) / 2.0;
        let mean = samples.iter().sum::<f64>() / samples.len() as f64;
        println!(
            "{name}: median_ms={median:.6} mean_ms={mean:.6} trials={}",
            samples.len()
        );
        println!("{name}_samples_ms={samples:?}");
    }

    pub fn run() {
        let trials = std::env::args()
            .nth(1)
            .map(|value| value.parse::<usize>().expect("trial count"))
            .unwrap_or(30);
        assert!(trials >= 20);
        if std::env::var_os("CAP_WINDOWS_PICKER_PNG_FILTERS").is_some() {
            png_filters(trials);
            return;
        }
        let mut listing = Vec::new();
        let mut picker = Vec::new();
        let mut icons = Vec::new();
        let mut repeated_icons = Vec::new();
        for trial in 0..trials + 3 {
            let start = Instant::now();
            let windows = black_box(Window::list());
            let list_ms = start.elapsed().as_secs_f64() * 1000.0;
            let start = Instant::now();
            let mut cache = WindowListCache::default();
            let targets = black_box(picker_windows(&mut cache));
            let picker_ms = start.elapsed().as_secs_f64() * 1000.0;
            let start = Instant::now();
            let pngs: Vec<_> = targets
                .iter()
                .map(|(window, _, _)| black_box(cache.app_icon(window)))
                .collect();
            let icons_ms = start.elapsed().as_secs_f64() * 1000.0;
            let start = Instant::now();
            let repeated: Vec<_> = targets
                .iter()
                .map(|(window, _, _)| black_box(cache.app_icon(window)))
                .collect();
            let repeated_ms = start.elapsed().as_secs_f64() * 1000.0;
            assert_eq!(pngs, repeated);
            if trial >= 3 {
                listing.push(list_ms);
                picker.push(picker_ms);
                icons.push(icons_ms);
                repeated_icons.push(repeated_ms);
                println!(
                    "trial={} listed={} picker={} icons={}",
                    trial - 2,
                    windows.len(),
                    targets.len(),
                    pngs.iter().filter(|icon| icon.is_some()).count()
                );
            }
        }
        report("Window_list", &listing);
        report("picker_list", &picker);
        report("picker_icons", &icons);
        report("picker_icons_same_refresh_repeat", &repeated_icons);
        let mut cache = WindowListCache::default();
        for (window, name, owner) in picker_windows(&mut cache) {
            let icon = cache.app_icon(&window).map(|bytes| {
                let rgba = image::load_from_memory(&bytes)
                    .expect("valid PNG")
                    .into_rgba8();
                let hash = rgba
                    .as_raw()
                    .iter()
                    .fold(0xcbf29ce484222325_u64, |hash, byte| {
                        (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
                    });
                (rgba.width(), rgba.height(), hash)
            });
            println!(
                "snapshot id={} owner={} name={} icon={icon:?}",
                window.id(),
                owner.escape_default(),
                name.escape_default()
            );
        }
    }

    fn png_filters(trials: usize) {
        use image::{
            ImageEncoder,
            codecs::png::{CompressionType, FilterType, PngEncoder},
        };
        let images: Vec<_> = picker_windows(&mut WindowListCache::default())
            .into_iter()
            .filter_map(|(window, _, _)| window.app_icon())
            .map(|bytes| {
                image::load_from_memory(&bytes)
                    .expect("valid PNG")
                    .into_rgba8()
            })
            .collect();
        for filter in [FilterType::Adaptive, FilterType::Sub, FilterType::NoFilter] {
            let mut samples = Vec::new();
            let mut byte_count = 0;
            for trial in 0..trials + 3 {
                let start = Instant::now();
                let encoded: Vec<_> = images
                    .iter()
                    .map(|image| {
                        let mut png = Vec::new();
                        PngEncoder::new_with_quality(&mut png, CompressionType::Fast, filter)
                            .write_image(
                                image.as_raw(),
                                image.width(),
                                image.height(),
                                image::ColorType::Rgba8,
                            )
                            .expect("encode PNG");
                        png
                    })
                    .collect();
                let elapsed = start.elapsed().as_secs_f64() * 1000.0;
                if trial >= 3 {
                    samples.push(elapsed);
                }
                byte_count = encoded.iter().map(Vec::len).sum::<usize>();
                for (original, png) in images.iter().zip(encoded) {
                    assert_eq!(
                        original,
                        &image::load_from_memory(&png)
                            .expect("valid PNG")
                            .into_rgba8()
                    );
                }
            }
            report(&format!("PNG_{filter:?}"), &samples);
            println!(
                "PNG_{filter:?}: icons={} bytes={byte_count} pixels_equal=true",
                images.len()
            );
        }
    }
}

fn main() {
    #[cfg(windows)]
    windows_bench::run();
    #[cfg(not(windows))]
    eprintln!("windows_picker_bench requires Windows");
}
