#![no_main]

use libfuzzer_sys::fuzz_target;
use terminus_fs::SafePath;

fuzz_target!(|data: &[u8]| {
    let input = String::from_utf8_lossy(data);
    // Lexical validation only; reject paths without panicking.
    let _ = SafePath::new(&input);
});
