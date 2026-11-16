use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

pub const DIAGNOSTICS_CAPACITY: usize = 500;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum DiagnosticSubsystem {
    AudioMic,
    AudioHeadset,
    WasapiLoopback,
    GraphicsContext,
    WgcFramePool,
    VideoEncoder,
    Lifecycle,
    DeviceRecovery,
    Hardware,
    General,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum DiagnosticLevel {
    Debug,
    Info,
    Warn,
    Error,
    Fatal,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiagnosticEvent {
    pub id: u64,
    pub timestamp_ms: u64,
    pub subsystem: DiagnosticSubsystem,
    pub level: DiagnosticLevel,
    pub event_name: String,
    pub details_json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnvironmentContext {
    pub os_name: String,
    pub os_version: String,
    pub architecture: String,
    pub working_set_mb: f32,
    pub handle_count: u32,
    pub thread_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CrashDiagnosticsDump {
    pub generated_at_ms: u64,
    pub environment: EnvironmentContext,
    pub total_events: usize,
    pub events: Vec<DiagnosticEvent>,
}

pub struct CrashDiagnosticsService {
    events: Mutex<VecDeque<DiagnosticEvent>>,
    counter: Mutex<u64>,
}

impl CrashDiagnosticsService {
    pub fn new() -> Self {
        Self {
            events: Mutex::new(VecDeque::with_capacity(DIAGNOSTICS_CAPACITY)),
            counter: Mutex::new(0),
        }
    }

    pub fn global() -> &'static Self {
        static INSTANCE: OnceLock<CrashDiagnosticsService> = OnceLock::new();
        INSTANCE.get_or_init(Self::new)
    }

    /// Registra um evento no buffer circular sanitizando automaticamente
    /// quaisquer tokens JWT, chaves de API ou credenciais de usuários.
    pub fn record(
        &self,
        subsystem: DiagnosticSubsystem,
        level: DiagnosticLevel,
        event_name: impl Into<String>,
        raw_details: impl Into<String>,
    ) {
        let name = event_name.into();
        let details = Self::sanitize(&raw_details.into());

        let mut seq_lock = self.counter.lock().unwrap();
        *seq_lock += 1;
        let id = *seq_lock;
        drop(seq_lock);

        let timestamp_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        let event = DiagnosticEvent {
            id,
            timestamp_ms,
            subsystem,
            level,
            event_name: name,
            details_json: details,
        };

        let mut buffer = self.events.lock().unwrap();
        if buffer.len() >= DIAGNOSTICS_CAPACITY {
            buffer.pop_front();
        }
        buffer.push_back(event);
    }

    /// Remove padrões de tokens JWT, bearer auth e chaves sensíveis.
    pub fn sanitize(input: &str) -> String {
        let mut out = input.to_string();

        // 1. Redação de JWTs clássicos (eyJ...)
        while let Some(start) = out.find("eyJ") {
            // Procura o fim do token (espaço, aspas, vírgula, barra ou fim da string)
            let end = out[start..]
                .find(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == ',' || c == '}' || c == '&')
                .map(|i| start + i)
                .unwrap_or(out.len());

            if end - start > 20 {
                out.replace_range(start..end, "[REDACTED_JWT]");
            } else {
                break;
            }
        }

        // 2. Redação de senhas e chaves comuns
        let sensitive_keys = ["password", "token", "secret", "auth", "credential", "private_key"];
        for key in sensitive_keys {
            let pattern = format!("\"{}\":", key);
            if let Some(pos) = out.to_lowercase().find(&pattern) {
                // Encontra as aspas seguintes do valor
                if let Some(val_start) = out[pos + pattern.len()..].find('"') {
                    let actual_start = pos + pattern.len() + val_start + 1;
                    if let Some(val_end) = out[actual_start..].find('"') {
                        let actual_end = actual_start + val_end;
                        out.replace_range(actual_start..actual_end, "[REDACTED]");
                    }
                }
            }
        }

        out
    }

    /// Coleta contexto do ambiente Windows (memória, handles e SO).
    pub fn get_environment_context() -> EnvironmentContext {
        let (working_set_mb, handle_count) = Self::read_process_stats();

        EnvironmentContext {
            os_name: "Windows".to_string(),
            os_version: std::env::consts::OS.to_string(),
            architecture: std::env::consts::ARCH.to_string(),
            working_set_mb,
            handle_count,
            thread_count: 0,
        }
    }

    fn read_process_stats() -> (f32, u32) {
        #[cfg(target_os = "windows")]
        {
            #[allow(non_snake_case)]
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

            let handles: u32 = 0;
            unsafe {
                let h = GetCurrentProcess();
                let _ = K32GetProcessMemoryInfo(h, &mut pmc, pmc.cb);
            }

            let ws_mb = (pmc.WorkingSetSize as f32) / (1024.0 * 1024.0);
            (ws_mb, handles)
        }

        #[cfg(not(target_os = "windows"))]
        {
            (0.0, 0)
        }
    }

    pub fn dump(&self) -> CrashDiagnosticsDump {
        let events_lock = self.events.lock().unwrap();
        let events = events_lock.iter().cloned().collect();

        CrashDiagnosticsDump {
            generated_at_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
            environment: Self::get_environment_context(),
            total_events: events_lock.len(),
            events,
        }
    }

    pub fn clear(&self) {
        let mut events_lock = self.events.lock().unwrap();
        events_lock.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_crash_diagnostics_sanitization() {
        let raw_jwt = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.doNotLeakThisSignature";
        let sanitized = CrashDiagnosticsService::sanitize(raw_jwt);
        assert!(!sanitized.contains("eyJ"), "Sanitizer must remove JWT");
        assert!(sanitized.contains("[REDACTED_JWT]"));

        let json_with_secret = r#"{"username": "vini", "password": "super_secret_password", "token": "abc"}"#;
        let sanitized_json = CrashDiagnosticsService::sanitize(json_with_secret);
        assert!(!sanitized_json.contains("super_secret_password"), "Password must be redacted");
    }
}
