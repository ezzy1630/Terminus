#![no_main]

use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    // Pure decoder; PatchError on malformed input is expected.
    let _ = terminus_patch::parse_unified_diff(data);
});
