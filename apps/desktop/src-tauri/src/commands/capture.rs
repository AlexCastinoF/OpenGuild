use crate::models::CaptureSource;
use base64::prelude::*;

#[cfg(target_os = "windows")]
#[allow(non_snake_case)]
mod win_sources {
    use super::*;
    use std::ffi::c_void;
    use std::mem;

    type BOOL = i32;
    type HWND = *mut c_void;
    type HDC = *mut c_void;
    type HBITMAP = *mut c_void;
    type HMONITOR = *mut c_void;
    type LPARAM = isize;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct RECT {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }

    #[repr(C)]
    struct MONITORINFOEXW {
        cbSize: u32,
        rcMonitor: RECT,
        rcWork: RECT,
        dwFlags: u32,
        szDevice: [u16; 32],
    }

    #[repr(C, packed)]
    struct BITMAPFILEHEADER {
        bfType: u16,
        bfSize: u32,
        bfReserved1: u16,
        bfReserved2: u16,
        bfOffBits: u32,
    }

    #[repr(C)]
    struct BITMAPINFOHEADER {
        biSize: u32,
        biWidth: i32,
        biHeight: i32,
        biPlanes: u16,
        biBitCount: u16,
        biCompression: u32,
        biSizeImage: u32,
        biXPelsPerMeter: i32,
        biYPelsPerMeter: i32,
        biClrUsed: u32,
        biClrImportant: u32,
    }

    unsafe extern "system" {
        fn GetDC(hWnd: HWND) -> HDC;
        fn ReleaseDC(hWnd: HWND, hDC: HDC) -> i32;
        fn CreateCompatibleDC(hDC: HDC) -> HDC;
        fn DeleteDC(hDC: HDC) -> BOOL;
        fn CreateCompatibleBitmap(hDC: HDC, cx: i32, cy: i32) -> HBITMAP;
        fn SelectObject(hDC: HDC, h: *mut c_void) -> *mut c_void;
        fn DeleteObject(ho: *mut c_void) -> BOOL;
        fn SetStretchBltMode(hDC: HDC, mode: i32) -> i32;
        fn StretchBlt(
            hdcDest: HDC,
            xDest: i32,
            yDest: i32,
            wDest: i32,
            hDest: i32,
            hdcSrc: HDC,
            xSrc: i32,
            ySrc: i32,
            wSrc: i32,
            hSrc: i32,
            rop: u32,
        ) -> BOOL;
        fn GetDIBits(
            hdc: HDC,
            hbm: HBITMAP,
            start: u32,
            cLines: u32,
            lpvBits: *mut c_void,
            lpbmi: *mut c_void,
            usage: u32,
        ) -> i32;

        fn EnumDisplayMonitors(
            hdc: HDC,
            lprcClip: *const RECT,
            lpfnEnum: Option<unsafe extern "system" fn(HMONITOR, HDC, *mut RECT, LPARAM) -> BOOL>,
            dwData: LPARAM,
        ) -> BOOL;
        fn GetMonitorInfoW(hMonitor: HMONITOR, lpmi: *mut MONITORINFOEXW) -> BOOL;

        fn EnumWindows(
            lpEnumFunc: Option<unsafe extern "system" fn(HWND, LPARAM) -> BOOL>,
            lParam: LPARAM,
        ) -> BOOL;
        fn IsWindowVisible(hWnd: HWND) -> BOOL;
        fn IsIconic(hWnd: HWND) -> BOOL;
        fn GetWindowTextW(hWnd: HWND, lpString: *mut u16, nMaxCount: i32) -> i32;
        fn GetWindowRect(hWnd: HWND, lpRect: *mut RECT) -> BOOL;
        fn GetWindowDC(hWnd: HWND) -> HDC;
        #[allow(dead_code)]
        fn PrintWindow(hWnd: HWND, hdcBlt: HDC, nFlags: u32) -> BOOL;
    }

    const SRCCOPY: u32 = 0x00CC0020;
    const HALFTONE: i32 = 4;
    const BI_RGB: u32 = 0;
    const DIB_RGB_COLORS: u32 = 0;

    fn capture_rect_to_bmp_data_url(hdc_src: HDC, src_x: i32, src_y: i32, src_w: i32, src_h: i32, target_w: i32, target_h: i32) -> Option<String> {
        if src_w <= 0 || src_h <= 0 || target_w <= 0 || target_h <= 0 {
            return None;
        }

        unsafe {
            let mem_dc = CreateCompatibleDC(hdc_src);
            if mem_dc.is_null() {
                return None;
            }
            let mem_bmp = CreateCompatibleBitmap(hdc_src, target_w, target_h);
            if mem_bmp.is_null() {
                DeleteDC(mem_dc);
                return None;
            }

            let old_bmp = SelectObject(mem_dc, mem_bmp as *mut c_void);
            SetStretchBltMode(mem_dc, HALFTONE);

            let ok = StretchBlt(
                mem_dc, 0, 0, target_w, target_h,
                hdc_src, src_x, src_y, src_w, src_h,
                SRCCOPY,
            );

            let mut result = None;
            if ok != 0 {
                let img_size = (target_w * target_h * 4) as usize;
                let mut pixels: Vec<u8> = vec![0; img_size];

                let mut bmi_header: BITMAPINFOHEADER = mem::zeroed();
                bmi_header.biSize = mem::size_of::<BITMAPINFOHEADER>() as u32;
                bmi_header.biWidth = target_w;
                bmi_header.biHeight = -target_h; // Top-down
                bmi_header.biPlanes = 1;
                bmi_header.biBitCount = 32;
                bmi_header.biCompression = BI_RGB;
                bmi_header.biSizeImage = img_size as u32;

                let lines = GetDIBits(
                    mem_dc,
                    mem_bmp,
                    0,
                    target_h as u32,
                    pixels.as_mut_ptr() as *mut c_void,
                    &mut bmi_header as *mut _ as *mut c_void,
                    DIB_RGB_COLORS,
                );

                if lines > 0 {
                    let file_header_size = mem::size_of::<BITMAPFILEHEADER>();
                    let info_header_size = mem::size_of::<BITMAPINFOHEADER>();
                    let total_size = file_header_size + info_header_size + img_size;

                    let bfh = BITMAPFILEHEADER {
                        bfType: 0x4D42, // "BM"
                        bfSize: total_size as u32,
                        bfReserved1: 0,
                        bfReserved2: 0,
                        bfOffBits: (file_header_size + info_header_size) as u32,
                    };

                    let mut bmp_bytes = Vec::with_capacity(total_size);
                    let bfh_slice = std::slice::from_raw_parts(&bfh as *const _ as *const u8, file_header_size);
                    let bih_slice = std::slice::from_raw_parts(&bmi_header as *const _ as *const u8, info_header_size);
                    bmp_bytes.extend_from_slice(bfh_slice);
                    bmp_bytes.extend_from_slice(bih_slice);
                    bmp_bytes.extend_from_slice(&pixels);

                    let b64 = BASE64_STANDARD.encode(&bmp_bytes);
                    result = Some(format!("data:image/bmp;base64,{}", b64));
                }
            }

            SelectObject(mem_dc, old_bmp);
            DeleteObject(mem_bmp as *mut c_void);
            DeleteDC(mem_dc);

            result
        }
    }

    struct MonitorEnumState {
        sources: Vec<CaptureSource>,
        screen_idx: usize,
    }

    unsafe extern "system" fn monitor_enum_proc(
        hmon: HMONITOR,
        _hdc: HDC,
        _rect: *mut RECT,
        lparam: LPARAM,
    ) -> BOOL {
        unsafe {
            let state = &mut *(lparam as *mut MonitorEnumState);
            let mut mi: MONITORINFOEXW = mem::zeroed();
            mi.cbSize = mem::size_of::<MONITORINFOEXW>() as u32;

            if GetMonitorInfoW(hmon, &mut mi) != 0 {
                let idx = state.screen_idx;
                state.screen_idx += 1;

                let w = mi.rcMonitor.right - mi.rcMonitor.left;
                let h = mi.rcMonitor.bottom - mi.rcMonitor.top;
                let is_primary = (mi.dwFlags & 1) != 0;

                let name = if is_primary {
                    format!("Monitor {} (Principal) — {}x{}", idx + 1, w, h)
                } else {
                    format!("Monitor {} — {}x{}", idx + 1, w, h)
                };

                let screen_dc = GetDC(std::ptr::null_mut());
                let thumb = if !screen_dc.is_null() {
                    let res = capture_rect_to_bmp_data_url(
                        screen_dc,
                        mi.rcMonitor.left,
                        mi.rcMonitor.top,
                        w,
                        h,
                        240,
                        135,
                    );
                    ReleaseDC(std::ptr::null_mut(), screen_dc);
                    res
                } else {
                    None
                };

                state.sources.push(CaptureSource {
                    id: format!("screen:{}", idx),
                    name,
                    thumbnail_data_url: thumb,
                    kind: Some("screen".to_string()),
                });
            }
            1
        }
    }

    struct WindowEnumState {
        sources: Vec<CaptureSource>,
    }

    unsafe extern "system" fn window_enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        unsafe {
            let state = &mut *(lparam as *mut WindowEnumState);

            if IsWindowVisible(hwnd) == 0 || IsIconic(hwnd) != 0 {
                return 1;
            }

            let mut title_buf = [0u16; 512];
            let len = GetWindowTextW(hwnd, title_buf.as_mut_ptr(), 512);
            if len <= 0 {
                return 1;
            }

            let title = String::from_utf16_lossy(&title_buf[..len as usize]).trim().to_string();
            if title.is_empty()
                || title == "Program Manager"
                || title == "Windows Input Experience"
                || title.starts_with("RallyDesk")
                || title.starts_with("SteamFarm")
            {
                return 1;
            }

            let mut rect: RECT = mem::zeroed();
            if GetWindowRect(hwnd, &mut rect) == 0 {
                return 1;
            }

            let w = rect.right - rect.left;
            let h = rect.bottom - rect.top;
            if w < 160 || h < 100 {
                return 1;
            }

            // Tenta capturar miniatura via PrintWindow ou GetWindowDC
            let win_dc = GetWindowDC(hwnd);
            let thumb = if !win_dc.is_null() {
                let res = capture_rect_to_bmp_data_url(win_dc, 0, 0, w, h, 240, 135);
                ReleaseDC(hwnd, win_dc);
                res
            } else {
                None
            };

            state.sources.push(CaptureSource {
                id: format!("window:{}", hwnd as usize),
                name: title,
                thumbnail_data_url: thumb,
                kind: Some("window".to_string()),
            });

            1
        }
    }

    pub fn enumerate_all_sources() -> Vec<CaptureSource> {
        let mut results = Vec::new();

        // 1. Monitores
        let mut mon_state = MonitorEnumState {
            sources: Vec::new(),
            screen_idx: 0,
        };
        unsafe {
            EnumDisplayMonitors(
                std::ptr::null_mut(),
                std::ptr::null(),
                Some(monitor_enum_proc),
                &mut mon_state as *mut _ as LPARAM,
            );
        }
        results.extend(mon_state.sources);

        // 2. Janelas
        let mut win_state = WindowEnumState {
            sources: Vec::new(),
        };
        unsafe {
            EnumWindows(
                Some(window_enum_proc),
                &mut win_state as *mut _ as LPARAM,
            );
        }
        // Limita a 20 janelas mais relevantes para não sobrecarregar
        let mut windows = win_state.sources;
        if windows.len() > 20 {
            windows.truncate(20);
        }
        results.extend(windows);

        results
    }
}

#[tauri::command]
pub fn get_picker_sources() -> Vec<CaptureSource> {
    #[cfg(target_os = "windows")]
    {
        let sources = win_sources::enumerate_all_sources();
        if !sources.is_empty() {
            return sources;
        }
    }

    vec![
        CaptureSource {
            id: "screen:0".to_string(),
            name: "Monitor 1 (Principal)".to_string(),
            thumbnail_data_url: None,
            kind: Some("screen".to_string()),
        }
    ]
}

#[tauri::command]
pub fn pick_source(id: String) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "ok": true, "id": id }))
}

#[tauri::command]
pub fn cancel_pick_source() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "ok": true }))
}

#[tauri::command]
pub fn start_local_stream(opts: serde_json::Value) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "ok": true, "opts": opts }))
}

#[tauri::command]
pub fn stop_local_stream() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "ok": true }))
}
