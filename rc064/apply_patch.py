import pathlib
import sys

root = pathlib.Path(sys.argv[1]) / "apps/desktop-gpui/src/upload"
here = pathlib.Path(__file__).parent
verify = root / "verify_tests.rs"
text = verify.read_text()
anchor = "    pub(super) fn confirmations(&self) -> Vec<Value> {"
assert anchor in text
text = text.replace(
    anchor,
    "    pub(super) fn rc064_objects(&self) -> Vec<(String, Vec<u8>)> {\n"
    "        self.lock().objects.iter().map(|(k, v)| (k.clone(), v.clone())).collect()\n"
    "    }\n\n" + anchor,
    1,
)
verify.write_text(text)
real = root / "real_app_tests.rs"
real.write_text(real.read_text() + (here / "mock_server_test.rs").read_text())
print("patched")
