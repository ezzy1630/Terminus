#![no_main]

use libfuzzer_sys::fuzz_target;
use terminus_policy::ShellAst;

fuzz_target!(|data: &[u8]| {
    let input = String::from_utf8_lossy(data);
    // Never panic on bad input: parse is total over UTF-8 lossy strings.
    let _ = ShellAst::parse(&input);
});
