#![allow(non_camel_case_types)]
#![allow(non_snake_case)]

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HardwareTelemetry {
    pub timestamp_ms: u64,
    pub cpu_global_pct: f32,
    pub cpu_process_pct: f32,
    pub ram_process_mb: f32,
    pub gpu_3d_pct: f32,
    pub gpu_video_encode_pct: f32,
    pub gpu_copy_engine_pct: f32,
    pub vram_used_mb: f32,
    pub vram_total_mb: f32,
}

impl Default for HardwareTelemetry {
    fn default() -> Self {
        Self {
            timestamp_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
            cpu_global_pct: 0.0,
            cpu_process_pct: 0.0,
            ram_process_mb: 0.0,
            gpu_3d_pct: 0.0,
            gpu_video_encode_pct: 0.0,
            gpu_copy_engine_pct: 0.0,
            vram_used_mb: 0.0,
            vram_total_mb: 0.0,
        }
    }
}

pub struct TelemetryService {
    running: Arc<AtomicBool>,
    last_sample: Arc<Mutex<HardwareTelemetry>>,
}

impl TelemetryService {
    pub fn new() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            last_sample: Arc::new(Mutex::new(HardwareTelemetry::default())),
        }
    }

    pub fn get_latest(&self) -> HardwareTelemetry {
        self.last_sample.lock().unwrap().clone()
    }

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    pub fn stop(&self) {
        self.running.store(false, Ordering::SeqCst);
    }

    pub fn start(&self, app: AppHandle) {
        if self.running.swap(true, Ordering::SeqCst) {
            return; // Already running
        }

        let running = self.running.clone();
        let last_sample = self.last_sample.clone();

        std::thread::Builder::new()
            .name("sf-telemetry-sampler".to_string())
            .spawn(move || {
                log::info!("[TelemetryService] Sampler thread started (500ms interval)");
                let mut sampler = WinTelemetrySampler::new();

                while running.load(Ordering::SeqCst) {
                    let sample = sampler.sample();
                    *last_sample.lock().unwrap() = sample.clone();

                    let _ = app.emit("sf:hardware-telemetry", &sample);

                    std::thread::sleep(Duration::from_millis(500));
                }

                log::info!("[TelemetryService] Sampler thread stopped cooperatively");
            })
            .expect("failed to spawn telemetry sampler thread");
    }
}

// ---------------------------------------------------------------------------
// Win32 Hardware Sampler (Direct FFI - Zero heavy dependencies)
// ---------------------------------------------------------------------------
#[cfg(target_os = "windows")]
struct WinTelemetrySampler {
    last_sys_idle: u64,
    last_sys_kernel: u64,
    last_sys_user: u64,
    last_proc_time: u64,
    last_instant: Instant,
    num_processors: u32,
    vram_total_mb: f32,
    pdh_sampler: Option<PdhGpuSampler>,
}

#[cfg(not(target_os = "windows"))]
struct WinTelemetrySampler;

#[cfg(not(target_os = "windows"))]
impl WinTelemetrySampler {
    fn new() -> Self {
        Self
    }
    fn sample(&mut self) -> HardwareTelemetry {
        HardwareTelemetry::default()
    }
}

#[cfg(target_os = "windows")]
impl WinTelemetrySampler {
    fn new() -> Self {
        let (sys_idle, sys_kernel, sys_user) = Self::read_system_times();
        let proc_time = Self::read_process_time();
        let num_processors = Self::read_num_processors();
        let vram_total_mb = crate::services::GpuService::get_capabilities()
            .primary_gpu
            .dedicated_vram_mb as f32;

        let pdh_sampler = PdhGpuSampler::new();

        Self {
            last_sys_idle: sys_idle,
            last_sys_kernel: sys_kernel,
            last_sys_user: sys_user,
            last_proc_time: proc_time,
            last_instant: Instant::now(),
            num_processors: num_processors.max(1),
            vram_total_mb,
            pdh_sampler,
        }
    }

    fn sample(&mut self) -> HardwareTelemetry {
        let now_instant = Instant::now();
        let elapsed_secs = now_instant.duration_since(self.last_instant).as_secs_f32();
        self.last_instant = now_instant;

        let (sys_idle, sys_kernel, sys_user) = Self::read_system_times();
        let proc_time = Self::read_process_time();

        let delta_sys_kernel = sys_kernel.saturating_sub(self.last_sys_kernel);
        let delta_sys_user = sys_user.saturating_sub(self.last_sys_user);
        let delta_sys_idle = sys_idle.saturating_sub(self.last_sys_idle);

        let delta_sys_total = delta_sys_kernel + delta_sys_user;
        let delta_proc = proc_time.saturating_sub(self.last_proc_time);

        self.last_sys_idle = sys_idle;
        self.last_sys_kernel = sys_kernel;
        self.last_sys_user = sys_user;
        self.last_proc_time = proc_time;

        // Global CPU %
        let cpu_global_pct = if delta_sys_total > 0 {
            let active = delta_sys_total.saturating_sub(delta_sys_idle);
            ((active as f32 / delta_sys_total as f32) * 100.0).clamp(0.0, 100.0)
        } else {
            0.0
        };

        // Process CPU % (scaled by number of CPU cores)
        let cpu_process_pct = if delta_sys_total > 0 && self.num_processors > 0 {
            ((delta_proc as f32 / delta_sys_total as f32) * 100.0).clamp(0.0, 100.0)
        } else if elapsed_secs > 0.0 {
            // Fallback: 100ns units to seconds
            let proc_secs = (delta_proc as f32) * 1e-7;
            ((proc_secs / (elapsed_secs * self.num_processors as f32)) * 100.0).clamp(0.0, 100.0)
        } else {
            0.0
        };

        // Process Working Set (RAM in MB)
        let ram_process_mb = Self::read_working_set_mb();

        // GPU metrics via PDH (3D, VideoEncode, CopyEngine)
        let (gpu_3d, gpu_enc, gpu_copy, vram_used) = if let Some(pdh) = self.pdh_sampler.as_mut() {
            pdh.sample(self.vram_total_mb)
        } else {
            (0.0, 0.0, 0.0, 0.0)
        };

        let timestamp_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        HardwareTelemetry {
            timestamp_ms,
            cpu_global_pct,
            cpu_process_pct,
            ram_process_mb,
            gpu_3d_pct: gpu_3d,
            gpu_video_encode_pct: gpu_enc,
            gpu_copy_engine_pct: gpu_copy,
            vram_used_mb: vram_used,
            vram_total_mb: self.vram_total_mb,
        }
    }

    fn read_system_times() -> (u64, u64, u64) {
        #[repr(C)]
        struct FILETIME {
            dwLowDateTime: u32,
            dwHighDateTime: u32,
        }
        unsafe extern "system" {
            fn GetSystemTimes(
                lpIdleTime: *mut FILETIME,
                lpKernelTime: *mut FILETIME,
                lpUserTime: *mut FILETIME,
            ) -> i32;
        }

        let mut idle = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
        let mut kernel = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
        let mut user = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };

        unsafe {
            GetSystemTimes(&mut idle, &mut kernel, &mut user);
        }

        let idle_u64 = ((idle.dwHighDateTime as u64) << 32) | (idle.dwLowDateTime as u64);
        let kernel_u64 = ((kernel.dwHighDateTime as u64) << 32) | (kernel.dwLowDateTime as u64);
        let user_u64 = ((user.dwHighDateTime as u64) << 32) | (user.dwLowDateTime as u64);

        (idle_u64, kernel_u64, user_u64)
    }

    fn read_process_time() -> u64 {
        #[repr(C)]
        struct FILETIME {
            dwLowDateTime: u32,
            dwHighDateTime: u32,
        }
        unsafe extern "system" {
            fn GetCurrentProcess() -> isize;
            fn GetProcessTimes(
                hProcess: isize,
                lpCreationTime: *mut FILETIME,
                lpExitTime: *mut FILETIME,
                lpKernelTime: *mut FILETIME,
                lpUserTime: *mut FILETIME,
            ) -> i32;
        }

        let mut creation = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
        let mut exit = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
        let mut kernel = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
        let mut user = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };

        unsafe {
            let handle = GetCurrentProcess();
            GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user);
        }

        let kernel_u64 = ((kernel.dwHighDateTime as u64) << 32) | (kernel.dwLowDateTime as u64);
        let user_u64 = ((user.dwHighDateTime as u64) << 32) | (user.dwLowDateTime as u64);

        kernel_u64 + user_u64
    }

    fn read_working_set_mb() -> f32 {
        #[repr(C)]
        struct PROCESS_MEMORY_COUNTERS {
            cb: u32,
            PageFaultCount: u32,
            PeakWorkingSetSize: usize,
            WorkingSetSize: usize,
            QuotaPeakPagedPoolUsage: usize,
            QuotaPagedPoolUsage: usize,
            QuotaPeakNonPagedPoolUsage: usize,
            QuotaNonPagedPoolUsage: usize,
            PagefileUsage: usize,
            PeakPagefileUsage: usize,
        }
        unsafe extern "system" {
            fn GetCurrentProcess() -> isize;
            fn K32GetProcessMemoryInfo(
                hProcess: isize,
                ppmc: *mut PROCESS_MEMORY_COUNTERS,
                cb: u32,
            ) -> i32;
        }

        let mut pmc = PROCESS_MEMORY_COUNTERS {
            cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
            PageFaultCount: 0,
            PeakWorkingSetSize: 0,
            WorkingSetSize: 0,
            QuotaPeakPagedPoolUsage: 0,
            QuotaPagedPoolUsage: 0,
            QuotaPeakNonPagedPoolUsage: 0,
            QuotaNonPagedPoolUsage: 0,
            PagefileUsage: 0,
            PeakPagefileUsage: 0,
        };

        unsafe {
            let handle = GetCurrentProcess();
            if K32GetProcessMemoryInfo(handle, &mut pmc, pmc.cb) != 0 {
                (pmc.WorkingSetSize as f32) / (1024.0 * 1024.0)
            } else {
                0.0
            }
        }
    }

    fn read_num_processors() -> u32 {
        #[repr(C)]
        struct SYSTEM_INFO {
            wProcessorArchitecture: u16,
            wReserved: u16,
            dwPageSize: u32,
            lpMinimumApplicationAddress: usize,
            lpMaximumApplicationAddress: usize,
            dwActiveProcessorMask: usize,
            dwNumberOfProcessors: u32,
            dwProcessorType: u32,
            dwAllocationGranularity: u32,
            wProcessorLevel: u16,
            wProcessorRevision: u16,
        }
        unsafe extern "system" {
            fn GetSystemInfo(lpSystemInfo: *mut SYSTEM_INFO);
        }

        let mut si: SYSTEM_INFO = unsafe { std::mem::zeroed() };
        unsafe {
            GetSystemInfo(&mut si);
        }
        si.dwNumberOfProcessors
    }
}

// ---------------------------------------------------------------------------
// PDH (Performance Data Helper) GPU Engine Sampler
// Queries Windows PDH for GPU 3D, Video Encode and Copy Engine load.
// ---------------------------------------------------------------------------
#[cfg(target_os = "windows")]
#[repr(C)]
struct PDH_FMT_COUNTERVALUE {
    CStatus: u32,
    dummy: u32,
    doubleValue: f64,
}

#[cfg(target_os = "windows")]
#[link(name = "pdh")]
unsafe extern "system" {
    fn PdhOpenQueryW(
        szDataSource: *const u16,
        dwUserData: usize,
        phQuery: *mut isize,
    ) -> u32;
    fn PdhAddEnglishCounterW(
        hQuery: isize,
        szFullCounterPath: *const u16,
        dwUserData: usize,
        phCounter: *mut isize,
    ) -> u32;
    fn PdhCollectQueryData(hQuery: isize) -> u32;
    fn PdhGetFormattedCounterValue(
        hCounter: isize,
        dwFormat: u32,
        lpdwType: *mut u32,
        pValue: *mut PDH_FMT_COUNTERVALUE,
    ) -> u32;
    fn PdhCloseQuery(hQuery: isize) -> u32;
}

#[cfg(target_os = "windows")]
struct PdhGpuSampler {
    query: isize,
    counter_3d: Option<isize>,
    counter_encode: Option<isize>,
    counter_copy: Option<isize>,
    counter_vram: Option<isize>,
}

#[cfg(target_os = "windows")]
impl PdhGpuSampler {
    fn new() -> Option<Self> {
        type PDH_HQUERY = isize;
        type PDH_HCOUNTER = isize;

        let mut query: PDH_HQUERY = 0;
        let res = unsafe { PdhOpenQueryW(std::ptr::null(), 0, &mut query) };
        if res != 0 || query == 0 {
            log::warn!("[PdhGpuSampler] PdhOpenQuery failed: 0x{:08X}", res);
            return None;
        }

        let to_wide = |s: &str| -> Vec<u16> {
            s.encode_utf16().chain(std::iter::once(0)).collect()
        };

        // In Windows, GPU Engine counters are named:
        // \GPU Engine(*_engtype_3D*)\Utilization Percentage
        // \GPU Engine(*_engtype_VideoEncode*)\Utilization Percentage
        // \GPU Engine(*_engtype_Copy*)\Utilization Percentage
        let mut counter_3d: PDH_HCOUNTER = 0;
        let path_3d = to_wide(r"\GPU Engine(*_engtype_3D*)\Utilization Percentage");
        let r3d = unsafe { PdhAddEnglishCounterW(query, path_3d.as_ptr(), 0, &mut counter_3d) };

        let mut counter_encode: PDH_HCOUNTER = 0;
        let path_encode = to_wide(r"\GPU Engine(*_engtype_VideoEncode*)\Utilization Percentage");
        let renc = unsafe { PdhAddEnglishCounterW(query, path_encode.as_ptr(), 0, &mut counter_encode) };

        let mut counter_copy: PDH_HCOUNTER = 0;
        let path_copy = to_wide(r"\GPU Engine(*_engtype_Copy*)\Utilization Percentage");
        let rcopy = unsafe { PdhAddEnglishCounterW(query, path_copy.as_ptr(), 0, &mut counter_copy) };

        let mut counter_vram: PDH_HCOUNTER = 0;
        let path_vram = to_wide(r"\GPU Process Memory(*)\Dedicated Usage");
        let rvram = unsafe { PdhAddEnglishCounterW(query, path_vram.as_ptr(), 0, &mut counter_vram) };

        // Initial prime collection
        unsafe {
            PdhCollectQueryData(query);
        }

        Some(Self {
            query,
            counter_3d: if r3d == 0 { Some(counter_3d) } else { None },
            counter_encode: if renc == 0 { Some(counter_encode) } else { None },
            counter_copy: if rcopy == 0 { Some(counter_copy) } else { None },
            counter_vram: if rvram == 0 { Some(counter_vram) } else { None },
        })
    }

    fn sample(&mut self, total_vram_mb: f32) -> (f32, f32, f32, f32) {
        const PDH_FMT_DOUBLE: u32 = 0x00000200;

        let res = unsafe { PdhCollectQueryData(self.query) };
        if res != 0 {
            return (0.0, 0.0, 0.0, 0.0);
        }

        let read_counter = |counter: Option<isize>| -> f32 {
            if let Some(h) = counter {
                let mut val = PDH_FMT_COUNTERVALUE {
                    CStatus: 0,
                    dummy: 0,
                    doubleValue: 0.0,
                };
                let mut c_type: u32 = 0;
                let r = unsafe { PdhGetFormattedCounterValue(h, PDH_FMT_DOUBLE, &mut c_type, &mut val) };
                if r == 0 && val.CStatus == 0 {
                    return val.doubleValue as f32;
                }
            }
            0.0
        };

        let val_3d = read_counter(self.counter_3d).clamp(0.0, 100.0);
        let val_enc = read_counter(self.counter_encode).clamp(0.0, 100.0);
        let val_copy = read_counter(self.counter_copy).clamp(0.0, 100.0);
        let raw_vram_bytes = read_counter(self.counter_vram);
        let val_vram = if raw_vram_bytes > 0.0 {
            (raw_vram_bytes / (1024.0 * 1024.0)).clamp(0.0, total_vram_mb.max(16384.0))
        } else {
            0.0
        };

        (val_3d, val_enc, val_copy, val_vram)
    }
}

#[cfg(target_os = "windows")]
impl Drop for PdhGpuSampler {
    fn drop(&mut self) {
        if self.query != 0 {
            unsafe {
                PdhCloseQuery(self.query);
            }
        }
    }
}
