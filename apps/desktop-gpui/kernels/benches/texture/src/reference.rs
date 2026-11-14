use crate::texture::Filter;

pub fn apply_filter(color: [f32; 3], filter: Filter) -> [f32; 3] {
    let clamp = |value: f32| value.clamp(0., 1.);
    let [r, g, b] = color;
    let out = match filter {
        Filter::Brightness(amount) => [r * amount, g * amount, b * amount],
        Filter::Contrast(amount) => [
            (r - 0.5) * amount + 0.5,
            (g - 0.5) * amount + 0.5,
            (b - 0.5) * amount + 0.5,
        ],
        Filter::Saturate(amount) | Filter::Grayscale(amount) => {
            let amount = if matches!(filter, Filter::Grayscale(_)) {
                1. - amount
            } else {
                amount
            };
            [
                (0.213 + 0.787 * amount) * r
                    + (0.715 - 0.715 * amount) * g
                    + (0.072 - 0.072 * amount) * b,
                (0.213 - 0.213 * amount) * r
                    + (0.715 + 0.285 * amount) * g
                    + (0.072 - 0.072 * amount) * b,
                (0.213 - 0.213 * amount) * r
                    + (0.715 - 0.715 * amount) * g
                    + (0.072 + 0.928 * amount) * b,
            ]
        }
        Filter::Sepia(amount) => {
            let lerp = |identity: f32, sepia: f32| identity + amount * (sepia - identity);
            [
                lerp(1., 0.393) * r + lerp(0., 0.769) * g + lerp(0., 0.189) * b,
                lerp(0., 0.349) * r + lerp(1., 0.686) * g + lerp(0., 0.168) * b,
                lerp(0., 0.272) * r + lerp(0., 0.534) * g + lerp(1., 0.131) * b,
            ]
        }
        Filter::HueRotate(degrees) => {
            let radians = degrees.to_radians();
            let (sin, cos) = (radians.sin(), radians.cos());
            [
                (0.213 + cos * 0.787 - sin * 0.213) * r
                    + (0.715 - cos * 0.715 - sin * 0.715) * g
                    + (0.072 - cos * 0.072 + sin * 0.928) * b,
                (0.213 - cos * 0.213 + sin * 0.143) * r
                    + (0.715 + cos * 0.285 + sin * 0.140) * g
                    + (0.072 - cos * 0.072 - sin * 0.283) * b,
                (0.213 - cos * 0.213 - sin * 0.787) * r
                    + (0.715 - cos * 0.715 + sin * 0.715) * g
                    + (0.072 + cos * 0.928 + sin * 0.072) * b,
            ]
        }
    };
    [clamp(out[0]), clamp(out[1]), clamp(out[2])]
}

pub fn apply_filters(color: [f32; 3], filters: &[Filter]) -> [f32; 3] {
    filters
        .iter()
        .fold(color, |color, filter| apply_filter(color, *filter))
}
