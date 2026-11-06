use crate::Rgba;

/// Mean SSIM over the masked pixels, computed on Rec. 709 luma with the usual
/// 11x11, sigma 1.5 gaussian window.
pub fn ssim(a: &Rgba, b: &Rgba, mask: &[bool]) -> f64 {
    assert_eq!((a.width, a.height), (b.width, b.height));
    let (width, height) = (a.width, a.height);
    let luma = |image: &Rgba| -> Vec<f64> {
        image
            .pixels
            .chunks_exact(4)
            .map(|px| 0.2126 * px[0] as f64 + 0.7152 * px[1] as f64 + 0.0722 * px[2] as f64)
            .collect()
    };
    let (x, y) = (luma(a), luma(b));
    let kernel = gaussian_kernel(1.5, 5);
    let blur = |values: &[f64]| separable_blur(values, width, height, &kernel);
    let xy: Vec<f64> = x.iter().zip(&y).map(|(x, y)| x * y).collect();
    let xx: Vec<f64> = x.iter().map(|x| x * x).collect();
    let yy: Vec<f64> = y.iter().map(|y| y * y).collect();
    let (mu_x, mu_y) = (blur(&x), blur(&y));
    let (e_xx, e_yy, e_xy) = (blur(&xx), blur(&yy), blur(&xy));
    let (c1, c2) = ((0.01f64 * 255.).powi(2), (0.03f64 * 255.).powi(2));
    let mut total = 0.;
    let mut count = 0usize;
    for index in 0..width * height {
        if !mask[index] {
            continue;
        }
        let (mx, my) = (mu_x[index], mu_y[index]);
        let vx = e_xx[index] - mx * mx;
        let vy = e_yy[index] - my * my;
        let cov = e_xy[index] - mx * my;
        total += ((2. * mx * my + c1) * (2. * cov + c2)) / ((mx * mx + my * my + c1) * (vx + vy + c2));
        count += 1;
    }
    if count == 0 { 1. } else { total / count as f64 }
}

/// CIEDE2000 colour difference per masked pixel, returned as (mean, p95).
pub fn delta_e(a: &Rgba, b: &Rgba, mask: &[bool]) -> (f64, f64) {
    let mut values: Vec<f64> = a
        .pixels
        .chunks_exact(4)
        .zip(b.pixels.chunks_exact(4))
        .zip(mask)
        .filter(|(_, keep)| **keep)
        .map(|((p, q), _)| ciede2000(srgb_to_lab(p), srgb_to_lab(q)))
        .collect();
    if values.is_empty() {
        return (0., 0.);
    }
    values.sort_by(f64::total_cmp);
    let mean = values.iter().sum::<f64>() / values.len() as f64;
    let p95 = values[((values.len() - 1) as f64 * 0.95).round() as usize];
    (mean, p95)
}

pub fn gaussian_kernel(sigma: f64, radius: usize) -> Vec<f64> {
    let mut kernel: Vec<f64> = (0..=2 * radius)
        .map(|i| {
            let x = i as f64 - radius as f64;
            (-(x * x) / (2. * sigma * sigma)).exp()
        })
        .collect();
    let sum: f64 = kernel.iter().sum();
    kernel.iter_mut().for_each(|value| *value /= sum);
    kernel
}

pub fn separable_blur(values: &[f64], width: usize, height: usize, kernel: &[f64]) -> Vec<f64> {
    let radius = kernel.len() / 2;
    let mut horizontal = vec![0.; values.len()];
    for row in 0..height {
        for col in 0..width {
            let mut sum = 0.;
            for (k, weight) in kernel.iter().enumerate() {
                let x = (col + k).saturating_sub(radius).min(width - 1);
                sum += weight * values[row * width + x];
            }
            horizontal[row * width + col] = sum;
        }
    }
    let mut out = vec![0.; values.len()];
    for row in 0..height {
        for col in 0..width {
            let mut sum = 0.;
            for (k, weight) in kernel.iter().enumerate() {
                let y = (row + k).saturating_sub(radius).min(height - 1);
                sum += weight * horizontal[y * width + col];
            }
            out[row * width + col] = sum;
        }
    }
    out
}

fn srgb_to_lab(px: &[f32]) -> [f64; 3] {
    let linear = |c: f32| {
        let c = (c as f64 / 255.).clamp(0., 1.);
        if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
    };
    let (r, g, b) = (linear(px[0]), linear(px[1]), linear(px[2]));
    let x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
    let y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b;
    let z = (0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / 1.08883;
    let f = |t: f64| {
        if t > 216. / 24389. { t.cbrt() } else { (24389. / 27. * t + 16.) / 116. }
    };
    let (fx, fy, fz) = (f(x), f(y), f(z));
    [116. * fy - 16., 500. * (fx - fy), 200. * (fy - fz)]
}

fn ciede2000(lab1: [f64; 3], lab2: [f64; 3]) -> f64 {
    let [l1, a1, b1] = lab1;
    let [l2, a2, b2] = lab2;
    let c1 = (a1 * a1 + b1 * b1).sqrt();
    let c2 = (a2 * a2 + b2 * b2).sqrt();
    let c_bar = (c1 + c2) / 2.;
    let g = 0.5 * (1. - (c_bar.powi(7) / (c_bar.powi(7) + 25f64.powi(7))).sqrt());
    let (a1p, a2p) = ((1. + g) * a1, (1. + g) * a2);
    let (c1p, c2p) = ((a1p * a1p + b1 * b1).sqrt(), (a2p * a2p + b2 * b2).sqrt());
    let hue = |b: f64, a: f64| {
        if a == 0. && b == 0. {
            0.
        } else {
            let h = b.atan2(a).to_degrees();
            if h < 0. { h + 360. } else { h }
        }
    };
    let (h1p, h2p) = (hue(b1, a1p), hue(b2, a2p));
    let dl = l2 - l1;
    let dc = c2p - c1p;
    let dh_angle = if c1p * c2p == 0. {
        0.
    } else if (h2p - h1p).abs() <= 180. {
        h2p - h1p
    } else if h2p - h1p > 180. {
        h2p - h1p - 360.
    } else {
        h2p - h1p + 360.
    };
    let dh = 2. * (c1p * c2p).sqrt() * (dh_angle.to_radians() / 2.).sin();
    let l_bar = (l1 + l2) / 2.;
    let cp_bar = (c1p + c2p) / 2.;
    let hp_bar = if c1p * c2p == 0. {
        h1p + h2p
    } else if (h1p - h2p).abs() <= 180. {
        (h1p + h2p) / 2.
    } else if h1p + h2p < 360. {
        (h1p + h2p + 360.) / 2.
    } else {
        (h1p + h2p - 360.) / 2.
    };
    let t = 1. - 0.17 * (hp_bar - 30.).to_radians().cos()
        + 0.24 * (2. * hp_bar).to_radians().cos()
        + 0.32 * (3. * hp_bar + 6.).to_radians().cos()
        - 0.20 * (4. * hp_bar - 63.).to_radians().cos();
    let d_theta = 30. * (-((hp_bar - 275.) / 25.).powi(2)).exp();
    let rc = 2. * (cp_bar.powi(7) / (cp_bar.powi(7) + 25f64.powi(7))).sqrt();
    let sl = 1. + (0.015 * (l_bar - 50.).powi(2)) / (20. + (l_bar - 50.).powi(2)).sqrt();
    let sc = 1. + 0.045 * cp_bar;
    let sh = 1. + 0.015 * cp_bar * t;
    let rt = -(2. * d_theta).to_radians().sin() * rc;
    ((dl / sl).powi(2) + (dc / sc).powi(2) + (dh / sh).powi(2) + rt * (dc / sc) * (dh / sh)).sqrt()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ciede2000_matches_published_pairs() {
        let pairs = [
            ([50.0, 2.6772, -79.7751], [50.0, 0.0, -82.7485], 2.0425),
            ([50.0, 3.1571, -77.2803], [50.0, 0.0, -82.7485], 2.8615),
            ([50.0, 2.5, 0.0], [73.0, 25.0, -18.0], 27.1492),
            ([60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644),
        ];
        for (a, b, expected) in pairs {
            assert!((ciede2000(a, b) - expected).abs() < 1e-3, "{a:?} {b:?}");
        }
    }

    #[test]
    fn identical_images_score_perfectly() {
        let image = Rgba::solid(16, 16, [120., 40., 200., 255.]);
        let mask = vec![true; 256];
        assert!((ssim(&image, &image, &mask) - 1.).abs() < 1e-9);
        assert_eq!(delta_e(&image, &image, &mask), (0., 0.));
    }
}
