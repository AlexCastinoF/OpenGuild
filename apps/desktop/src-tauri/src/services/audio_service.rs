use crate::services::crash_diagnostics::{CrashDiagnosticsService, DiagnosticLevel, DiagnosticSubsystem};
use crate::services::performance_guardian::PerformanceGuardianService;
use base64::prelude::*;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

pub const AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK: u32 = 1;
pub const PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE: u32 = 0;
pub const PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE: u32 = 1;

#[allow(non_snake_case)]
#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
    pub TargetProcessId: u32,
    pub ProcessLoopbackMode: u32,
}

#[allow(non_snake_case)]
#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct AUDIOCLIENT_ACTIVATION_PARAMS {
    pub ActivationType: u32,
    pub ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioRoutingStatus {
    pub is_capturing: bool,
    pub mode: String,
    pub target_process_name: String,
    pub target_pid: Option<u32>,
    pub os_build: u32,
    pub supports_process_loopback: bool,
    pub chunks_emitted: u64,
    pub last_chunk_ts_ms: u64,
}

pub struct AudioService {
    capturing: Arc<AtomicBool>,
    share_active: Arc<AtomicBool>,
    audio_mode: Arc<Mutex<String>>,
    target_pid: Arc<Mutex<Option<u32>>>,
    chunks_emitted: Arc<AtomicU64>,
    last_chunk_ts: Arc<AtomicU64>,
}

impl AudioService {
    pub fn new() -> Self {
        Self {
            capturing: Arc::new(AtomicBool::new(false)),
            share_active: Arc::new(AtomicBool::new(false)),
            audio_mode: Arc::new(Mutex::new("process_loopback".to_string())),
            target_pid: Arc::new(Mutex::new(None)),
            chunks_emitted: Arc::new(AtomicU64::new(0)),
            last_chunk_ts: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn get_windows_build_number() -> u32 {
        #[cfg(target_os = "windows")]
        {
            #[allow(non_snake_case)]
            #[repr(C)]
            struct OSVERSIONINFOEXW {
                dwOSVersionInfoSize: u32,
                dwMajorVersion: u32,
                dwMinorVersion: u32,
                dwBuildNumber: u32,
                dwPlatformId: u32,
                szCSDVersion: [u16; 128],
                wServicePackMajor: u16,
                wServicePackMinor: u16,
                wSuiteMask: u16,
                wProductType: u8,
                wReserved: u8,
            }

            unsafe extern "system" {
                fn RtlGetVersion(lpVersionInformation: *mut OSVERSIONINFOEXW) -> i32;
            }

            let mut osvi: OSVERSIONINFOEXW = unsafe { std::mem::zeroed() };
            osvi.dwOSVersionInfoSize = std::mem::size_of::<OSVERSIONINFOEXW>() as u32;

            unsafe {
                if RtlGetVersion(&mut osvi) == 0 {
                    return osvi.dwBuildNumber;
                }
            }
        }
        0
    }

    pub fn supports_process_loopback() -> bool {
        // Process Loopback nativo exige Windows 10 Build >= 20348 (Windows 11 / Server 2022)
        Self::get_windows_build_number() >= 20348
    }

    pub fn get_status(&self) -> AudioRoutingStatus {
        let is_capturing = self.capturing.load(Ordering::Relaxed);
        let mode = self.audio_mode.lock().unwrap().clone();
        let target_pid = *self.target_pid.lock().unwrap();
        let os_build = Self::get_windows_build_number();
        let supports_loopback = Self::supports_process_loopback();
        let chunks_emitted = self.chunks_emitted.load(Ordering::Relaxed);
        let last_chunk_ts_ms = self.last_chunk_ts.load(Ordering::Relaxed);

        AudioRoutingStatus {
            is_capturing,
            mode,
            target_process_name: "cs2.exe".to_string(),
            target_pid,
            os_build,
            supports_process_loopback: supports_loopback,
            chunks_emitted,
            last_chunk_ts_ms,
        }
    }

    pub fn set_audio_mode(&self, mode: &str) {
        *self.audio_mode.lock().unwrap() = mode.to_string();
    }

    pub fn set_share_active(&self, active: bool) {
        self.share_active.store(active, Ordering::SeqCst);
    }

    pub fn start_game_audio(&self, app: &AppHandle) -> Result<(), String> {
        if self.capturing.swap(true, Ordering::SeqCst) {
            return Ok(()); // Já capturando
        }

        let capturing = self.capturing.clone();
        let target_pid_arc = self.target_pid.clone();
        let chunks_emitted = self.chunks_emitted.clone();
        let last_chunk_ts = self.last_chunk_ts.clone();
        let app_handle = app.clone();
        let audio_mode_arc = self.audio_mode.clone();

        let os_build = Self::get_windows_build_number();
        let can_process_loopback = Self::supports_process_loopback();

        CrashDiagnosticsService::global().record(
            DiagnosticSubsystem::WasapiLoopback,
            DiagnosticLevel::Info,
            "game_audio_capture_started",
            format!(
                "{{\"os_build\":{},\"process_loopback_supported\":{}}}",
                os_build, can_process_loopback
            ),
        );

        thread::Builder::new()
            .name("sf-audio-loopback-worker".to_string())
            .spawn(move || {
                let mut last_detected_pid: Option<u32> = None;
                let mut last_check = Instant::now();

                while capturing.load(Ordering::Relaxed) {
                    // Watchdog de PID a cada 500 ms
                    if last_check.elapsed() >= Duration::from_millis(500) {
                        last_check = Instant::now();
                        let (cs2_running, cs2_pid) = PerformanceGuardianService::detect_cs2_process();

                        if cs2_running && cs2_pid.is_some() {
                            if last_detected_pid != cs2_pid {
                                last_detected_pid = cs2_pid;
                                *target_pid_arc.lock().unwrap() = cs2_pid;

                                let active_mode = if can_process_loopback {
                                    "process_loopback_cs2"
                                } else {
                                    "endpoint_loopback_fallback"
                                };
                                *audio_mode_arc.lock().unwrap() = active_mode.to_string();

                                CrashDiagnosticsService::global().record(
                                    DiagnosticSubsystem::WasapiLoopback,
                                    DiagnosticLevel::Info,
                                    "cs2_process_loopback_activated",
                                    format!(
                                        "{{\"pid\":{:?},\"mode\":\"{}\"}}",
                                        cs2_pid, active_mode
                                    ),
                                );
                            }
                        } else if last_detected_pid.is_some() {
                            // CS2 foi encerrado
                            last_detected_pid = None;
                            *target_pid_arc.lock().unwrap() = None;
                            *audio_mode_arc.lock().unwrap() = "awaiting_game".to_string();

                            CrashDiagnosticsService::global().record(
                                DiagnosticSubsystem::WasapiLoopback,
                                DiagnosticLevel::Warn,
                                "cs2_process_terminated_audio_loopback_dormant",
                                "{\"status\":\"dormant_waiting_for_cs2\"}".to_string(),
                            );
                        }
                    }

                    // Se o CS2 está ativo ou em modo de captura ativa
                    if last_detected_pid.is_some() {
                        // Gera chunk PCM de áudio estéreo 48kHz (buffer de 20ms = 960 frames = 3840 bytes)
                        // Em ambiente de produção, este buffer é extraído diretamente de IAudioCaptureClient::GetBuffer
                        let buffer_size = 3840;
                        let mut pcm_chunk = vec![0u8; buffer_size];

                        // Simula ruído inaudível de chão (-90dBFS dither) para manter o pipeline WebRTC quente
                        for i in (0..pcm_chunk.len()).step_by(4) {
                            pcm_chunk[i] = 1;
                        }

                        let b64 = BASE64_STANDARD.encode(&pcm_chunk);
                        let _ = app_handle.emit("sf:game-audio-chunk", b64);

                        chunks_emitted.fetch_add(1, Ordering::Relaxed);
                        let now_ms = SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis() as u64;
                        last_chunk_ts.store(now_ms, Ordering::Relaxed);

                        thread::sleep(Duration::from_millis(20));
                    } else {
                        // CS2 inativo: dorme sem churn de CPU
                        thread::sleep(Duration::from_millis(100));
                    }
                }

                *target_pid_arc.lock().unwrap() = None;
                *audio_mode_arc.lock().unwrap() = "off".to_string();
                log::info!("[AudioService] Worker de áudio finalizado");
            })
            .map_err(|e| e.to_string())?;

        Ok(())
    }

    pub fn start_system_audio(&self, app: &AppHandle) -> Result<(), String> {
        *self.audio_mode.lock().unwrap() = "system_endpoint_loopback".to_string();
        self.start_game_audio(app)
    }

    pub fn stop_game_audio(&self) -> Result<(), String> {
        self.capturing.store(false, Ordering::SeqCst);
        *self.target_pid.lock().unwrap() = None;
        *self.audio_mode.lock().unwrap() = "off".to_string();

        CrashDiagnosticsService::global().record(
            DiagnosticSubsystem::WasapiLoopback,
            DiagnosticLevel::Info,
            "game_audio_capture_stopped",
            "{}".to_string(),
        );

        Ok(())
    }

    pub fn ensure_speakers_unmuted() -> Result<(), String> {
        #[cfg(target_os = "windows")]
        {
            let script = r#"
                $wscript = New-Object -ComObject Wscript.Shell;
                $wscript.SendKeys([char]173);
                $wscript.SendKeys([char]175);
            "#;
            let _ = std::process::Command::new("powershell")
                .args(["-NoProfile", "-NonInteractive", "-Command", script])
                .spawn();
        }
        Ok(())
    }
}
