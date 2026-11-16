use crate::services::crash_diagnostics::{
    CrashDiagnosticsService, DiagnosticLevel, DiagnosticSubsystem,
};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum GuardianPressureLevel {
    Normal,
    Moderate,
    High,
    Critical,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GuardianStatus {
    pub pressure_level: GuardianPressureLevel,
    pub cpu_global_pct: f32,
    pub cpu_app_pct: f32,
    pub cs2_running: bool,
    pub cs2_pid: Option<u32>,
    pub timestamp_ms: u64,
}

pub struct PerformanceGuardianService {
    running: Arc<AtomicBool>,
    status: Arc<Mutex<GuardianStatus>>,
}

impl PerformanceGuardianService {
    pub fn new() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            status: Arc::new(Mutex::new(GuardianStatus {
                pressure_level: GuardianPressureLevel::Normal,
                cpu_global_pct: 0.0,
                cpu_app_pct: 0.0,
                cs2_running: false,
                cs2_pid: None,
                timestamp_ms: 0,
            })),
        }
    }

    pub fn calculate_pressure_level(
        cpu_global: f32,
        cpu_app: f32,
        cs2_running: bool,
    ) -> GuardianPressureLevel {
        if cpu_global >= 92.0 || cpu_app >= 40.0 {
            GuardianPressureLevel::Critical
        } else if cpu_global >= 85.0 || (cs2_running && cpu_global >= 80.0) {
            GuardianPressureLevel::High
        } else if cpu_global >= 70.0 || (cs2_running && cpu_app >= 15.0) {
            GuardianPressureLevel::Moderate
        } else {
            GuardianPressureLevel::Normal
        }
    }

    pub fn start(&self, app_handle: AppHandle) {
        if self.running.swap(true, Ordering::SeqCst) {
            return;
        }

        let running = self.running.clone();
        let status_arc = self.status.clone();

        thread::Builder::new()
            .name("sf-performance-guardian".to_string())
            .spawn(move || {
                let mut prev_idle: u64 = 0;
                let mut prev_kernel: u64 = 0;
                let mut prev_user: u64 = 0;
                let mut prev_proc_time: u64 = 0;
                let mut prev_instant = Instant::now();
                let num_cpus = Self::get_num_processors();
                let mut last_pressure = GuardianPressureLevel::Normal;

                while running.load(Ordering::Relaxed) {
                    let loop_start = Instant::now();

                    // 1. Amostra CPU do Sistema e do Processo
                    let (idle, kernel, user) = Self::read_system_times();
                    let proc_time = Self::read_process_cpu_time();

                    let sys_diff = (kernel.saturating_sub(prev_kernel)) + (user.saturating_sub(prev_user));
                    let idle_diff = idle.saturating_sub(prev_idle);

                    let cpu_global = if sys_diff > 0 {
                        let active = sys_diff.saturating_sub(idle_diff);
                        ((active as f64 / sys_diff as f64) * 100.0) as f32
                    } else {
                        0.0
                    };

                    let elapsed_sec = prev_instant.elapsed().as_secs_f64();
                    let cpu_app = if elapsed_sec > 0.0 {
                        let diff_100ns = proc_time.saturating_sub(prev_proc_time);
                        let diff_sec = (diff_100ns as f64) / 10_000_000.0;
                        ((diff_sec / (elapsed_sec * num_cpus as f64)) * 100.0) as f32
                    } else {
                        0.0
                    };

                    prev_idle = idle;
                    prev_kernel = kernel;
                    prev_user = user;
                    prev_proc_time = proc_time;
                    prev_instant = loop_start;

                    // 2. Watchdog de CS2 (detecção em tempo real do cs2.exe)
                    let (cs2_running, cs2_pid) = Self::detect_cs2_process();

                    // 3. Avaliação de Pressão e Degradação Preditiva
                    let pressure = Self::calculate_pressure_level(cpu_global, cpu_app, cs2_running);

                    let now_ms = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64;

                    let new_status = GuardianStatus {
                        pressure_level: pressure,
                        cpu_global_pct: cpu_global.clamp(0.0, 100.0),
                        cpu_app_pct: cpu_app.clamp(0.0, 100.0),
                        cs2_running,
                        cs2_pid,
                        timestamp_ms: now_ms,
                    };

                    {
                        let mut lock = status_arc.lock().unwrap();
                        *lock = new_status.clone();
                    }

                    // Se houve alteração de nível de pressão, emite alerta instantâneo
                    if pressure != last_pressure {
                        let level_str = match pressure {
                            GuardianPressureLevel::Normal => "normal",
                            GuardianPressureLevel::Moderate => "moderate",
                            GuardianPressureLevel::High => "high",
                            GuardianPressureLevel::Critical => "critical",
                        };

                        CrashDiagnosticsService::global().record(
                            DiagnosticSubsystem::Hardware,
                            match pressure {
                                GuardianPressureLevel::Critical => DiagnosticLevel::Error,
                                GuardianPressureLevel::High => DiagnosticLevel::Warn,
                                _ => DiagnosticLevel::Info,
                            },
                            "guardian_pressure_transition",
                            format!(
                                "{{\"level\":\"{}\",\"cpu_global\":{:.1},\"cpu_app\":{:.1},\"cs2\":{}}}",
                                level_str, cpu_global, cpu_app, cs2_running
                            ),
                        );

                        let _ = app_handle.emit("sf:performance-guardian-alert", &new_status);
                        last_pressure = pressure;
                    }

                    // Ciclo de alta frequência de 50 ms para detecção ultrarrápida (< 50 ms)
                    let elapsed = loop_start.elapsed();
                    let target_tick = Duration::from_millis(50);
                    if elapsed < target_tick {
                        thread::sleep(target_tick - elapsed);
                    }
                }
            })
            .expect("Failed to spawn PerformanceGuardian thread");
    }

    pub fn stop(&self) {
        self.running.store(false, Ordering::SeqCst);
    }

    pub fn get_status(&self) -> GuardianStatus {
        self.status.lock().unwrap().clone()
    }

    pub fn read_system_times() -> (u64, u64, u64) {
        #[cfg(target_os = "windows")]
        {
            #[allow(non_snake_case)]
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
                if GetSystemTimes(&mut idle, &mut kernel, &mut user) != 0 {
                    let idle_u64 = ((idle.dwHighDateTime as u64) << 32) | (idle.dwLowDateTime as u64);
                    let kernel_u64 = ((kernel.dwHighDateTime as u64) << 32) | (kernel.dwLowDateTime as u64);
                    let user_u64 = ((user.dwHighDateTime as u64) << 32) | (user.dwLowDateTime as u64);
                    return (idle_u64, kernel_u64, user_u64);
                }
            }
        }
        (0, 0, 0)
    }

    pub fn read_process_cpu_time() -> u64 {
        #[cfg(target_os = "windows")]
        {
            #[allow(non_snake_case)]
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
                if GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) != 0 {
                    let k = ((kernel.dwHighDateTime as u64) << 32) | (kernel.dwLowDateTime as u64);
                    let u = ((user.dwHighDateTime as u64) << 32) | (user.dwLowDateTime as u64);
                    return k + u;
                }
            }
        }
        0
    }

    fn get_num_processors() -> u32 {
        #[cfg(target_os = "windows")]
        {
            #[allow(non_snake_case)]
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
            si.dwNumberOfProcessors.max(1)
        }
        #[cfg(not(target_os = "windows"))]
        {
            1
        }
    }

    pub fn detect_cs2_process() -> (bool, Option<u32>) {
        #[cfg(target_os = "windows")]
        {
            #[allow(non_snake_case)]
            #[repr(C)]
            struct PROCESSENTRY32W {
                dwSize: u32,
                cntUsage: u32,
                th32ProcessID: u32,
                th32DefaultHeapID: usize,
                th32ModuleID: u32,
                cntThreads: u32,
                th32ParentProcessID: u32,
                pcPriClassBase: i32,
                dwFlags: u32,
                szExeFile: [u16; 260],
            }

            const TH32CS_SNAPPROCESS: u32 = 0x00000002;
            const INVALID_HANDLE_VALUE: isize = -1;

            unsafe extern "system" {
                fn CreateToolhelp32Snapshot(dwFlags: u32, th32ProcessID: u32) -> isize;
                fn Process32FirstW(hSnapshot: isize, lppe: *mut PROCESSENTRY32W) -> i32;
                fn Process32NextW(hSnapshot: isize, lppe: *mut PROCESSENTRY32W) -> i32;
                fn CloseHandle(hObject: isize) -> i32;
            }

            unsafe {
                let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
                if snapshot == INVALID_HANDLE_VALUE || snapshot == 0 {
                    return (false, None);
                }

                let mut pe: PROCESSENTRY32W = std::mem::zeroed();
                pe.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;

                if Process32FirstW(snapshot, &mut pe) != 0 {
                    loop {
                        let name_len = pe.szExeFile.iter().position(|&c| c == 0).unwrap_or(pe.szExeFile.len());
                        let name = String::from_utf16_lossy(&pe.szExeFile[..name_len]);

                        if name.eq_ignore_ascii_case("cs2.exe") {
                            let pid = pe.th32ProcessID;
                            CloseHandle(snapshot);
                            return (true, Some(pid));
                        }

                        if Process32NextW(snapshot, &mut pe) == 0 {
                            break;
                        }
                    }
                }

                CloseHandle(snapshot);
            }
        }
        (false, None)
    }
}
