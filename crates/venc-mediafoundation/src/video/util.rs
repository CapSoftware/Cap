use windows::Graphics::SizeInt32;

pub fn ensure_even(value: i32) -> i32 {
    if value % 2 == 0 { value } else { value + 1 }
}

pub fn ensure_even_size(size: SizeInt32) -> SizeInt32 {
    SizeInt32 {
        Width: ensure_even(size.Width),
        Height: ensure_even(size.Height),
    }
}
