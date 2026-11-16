// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "windows")]
fn set_app_user_model_id() {
    use std::os::windows::ffi::OsStrExt;
    let wide: Vec<u16> = std::ffi::OsStr::new("app.rallydesk.desktop")
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    unsafe {
        #[link(name = "shell32")]
        unsafe extern "system" {
            fn SetCurrentProcessExplicitAppUserModelID(AppID: *const u16) -> i32;
        }
        let _ = SetCurrentProcessExplicitAppUserModelID(wide.as_ptr());
    }
}

fn main() {
    #[cfg(target_os = "windows")]
    set_app_user_model_id();

    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--test-stage2") {
        let code = app_lib::run_stage2_tests();
        std::process::exit(code);
    }
    if args.iter().any(|a| a == "--test-stage3") {
        let code = app_lib::run_stage3_tests();
        std::process::exit(code);
    }
    if args.iter().any(|a| a == "--test-stage4") {
        let code = app_lib::run_stage4_tests();
        std::process::exit(code);
    }
    if args.iter().any(|a| a == "--test-stage5") {
        let code = app_lib::run_stage5_tests();
        std::process::exit(code);
    }
    if args.iter().any(|a| a == "--test-stage6") {
        let code = app_lib::run_stage6_tests();
        std::process::exit(code);
    }
    if args.iter().any(|a| a == "--test-stage7") {
        let code = app_lib::run_stage7_tests();
        std::process::exit(code);
    }
    if args.iter().any(|a| a == "--test-stage8") {
        let code = app_lib::run_stage8_tests();
        std::process::exit(code);
    }
    if args.iter().any(|a| a == "--test-stage9") {
        let code = app_lib::run_stage9_tests();
        std::process::exit(code);
    }
    app_lib::run();
}
