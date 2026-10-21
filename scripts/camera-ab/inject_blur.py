import pathlib, sys

root = pathlib.Path(sys.argv[1])
variant = sys.argv[2]
src = root / "apps/desktop-gpui/src"
here = pathlib.Path(__file__).parent

adapters = {
    "base": """fn step(
    blur: &mut PortableCameraBlur,
    image: &gpui::RenderImage,
    dims: (usize, usize),
    mode: cap_camera_effects::BlurMode,
    at: Instant,
) -> Option<Instant> {
    blur.process(image, dims, mode).expect("blur");
    Some(at)
}
""",
    "head": """fn step(
    blur: &mut PortableCameraBlur,
    image: &gpui::RenderImage,
    dims: (usize, usize),
    mode: cap_camera_effects::BlurMode,
    at: Instant,
) -> Option<Instant> {
    blur.process(image, dims, mode).expect("blur");
    Some(at)
}
""",
}

bench = (here / "blur_ab_bench.rs").read_text().replace("//ADAPTER\n", adapters[variant])
(src / "blur_ab_bench.rs").write_text(bench)
main = src / "main.rs"
s = main.read_text()
anchor = "mod camera_blur_portable;\n"
if s.count(anchor) != 1:
    raise SystemExit("main.rs anchor missing")
if "mod blur_ab_bench;" not in s:
    main.write_text(s.replace(anchor, anchor + "#[cfg(test)]\nmod blur_ab_bench;\n"))
print("blur bench injected", variant)
