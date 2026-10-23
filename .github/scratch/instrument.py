import sys
p = 'crates/editor/src/audio.rs'
s = open(p).read()
old = '''    pub(super) extern "C" fn on_memory_pressure(_context: *mut c_void) {
'''
new = '''    pub(super) extern "C" fn on_memory_pressure(_context: *mut c_void) {
        if std::thread::current().name().is_none() {
            eprintln!("OS MEMORY PRESSURE EVENT at {:?}", std::time::SystemTime::now());
        }
'''
assert s.count(old) == 1
s = s.replace(old, new)
if sys.argv[1] == 'after':
    old = '''    pub(super) fn watch() {
        static WATCH'''
    new = '''    pub(super) fn watch() {
        if cfg!(test) {
            return;
        }
        static WATCH'''
    assert s.count(old) == 1
    s = s.replace(old, new)
open(p, 'w').write(s)
