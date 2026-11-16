use crate::services::crash_diagnostics::{
    CrashDiagnosticsService, DiagnosticLevel, DiagnosticSubsystem,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum SubsystemId {
    Microphone,
    Headset,
    DefaultEndpoint,
    Bluetooth,
    WasapiLoopback,
    GraphicsContext,
    WgcFramePool,
    VideoEncoder,
}

impl SubsystemId {
    pub fn to_diagnostic_subsystem(&self) -> DiagnosticSubsystem {
        match self {
            Self::Microphone => DiagnosticSubsystem::AudioMic,
            Self::Headset => DiagnosticSubsystem::AudioHeadset,
            Self::DefaultEndpoint => DiagnosticSubsystem::AudioHeadset,
            Self::Bluetooth => DiagnosticSubsystem::DeviceRecovery,
            Self::WasapiLoopback => DiagnosticSubsystem::WasapiLoopback,
            Self::GraphicsContext => DiagnosticSubsystem::GraphicsContext,
            Self::WgcFramePool => DiagnosticSubsystem::WgcFramePool,
            Self::VideoEncoder => DiagnosticSubsystem::VideoEncoder,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SubsystemHealth {
    Healthy,
    Degraded { reason: String },
    Recovering { attempt: u32, started_at_ms: u64 },
    Failed { error: String, failed_at_ms: u64 },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubsystemStatus {
    pub id: SubsystemId,
    pub health: SubsystemHealth,
    pub recovery_count: u32,
    pub last_recovered_ms: Option<u64>,
}

type RecoveryHandler = Box<dyn Fn() -> Result<(), String> + Send + Sync + 'static>;

pub struct NativeDeviceRecoveryManager {
    subsystems: Mutex<HashMap<SubsystemId, SubsystemStatus>>,
    handlers: Mutex<HashMap<SubsystemId, Arc<RecoveryHandler>>>,
    app_handle: Mutex<Option<AppHandle>>,
}

impl NativeDeviceRecoveryManager {
    pub fn new() -> Self {
        let mut map = HashMap::new();
        let all = [
            SubsystemId::Microphone,
            SubsystemId::Headset,
            SubsystemId::DefaultEndpoint,
            SubsystemId::Bluetooth,
            SubsystemId::WasapiLoopback,
            SubsystemId::GraphicsContext,
            SubsystemId::WgcFramePool,
            SubsystemId::VideoEncoder,
        ];
        for id in all {
            map.insert(
                id,
                SubsystemStatus {
                    id,
                    health: SubsystemHealth::Healthy,
                    recovery_count: 0,
                    last_recovered_ms: None,
                },
            );
        }

        Self {
            subsystems: Mutex::new(map),
            handlers: Mutex::new(HashMap::new()),
            app_handle: Mutex::new(None),
        }
    }

    pub fn global() -> &'static Self {
        static INSTANCE: OnceLock<NativeDeviceRecoveryManager> = OnceLock::new();
        INSTANCE.get_or_init(Self::new)
    }

    pub fn attach_app_handle(&self, handle: AppHandle) {
        let mut lock = self.app_handle.lock().unwrap();
        *lock = Some(handle);
    }

    /// Registra rotina de recuperação isolada para um subsistema específico.
    pub fn register_handler<F>(&self, id: SubsystemId, handler: F)
    where
        F: Fn() -> Result<(), String> + Send + Sync + 'static,
    {
        let mut lock = self.handlers.lock().unwrap();
        lock.insert(id, Arc::new(Box::new(handler)));
    }

    /// Dispara a recuperação de um único subsistema isolado SEM afetar os demais.
    /// Exemplo: queda do microfone recupera apenas o microfone; o encoder e gráficos
    /// continuam operando normalmente sem reiniciar.
    pub fn trigger_recovery(&self, id: SubsystemId, reason: &str) -> Result<(), String> {
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        // 1. Verifica se já está recuperando
        let attempt = {
            let mut lock = self.subsystems.lock().unwrap();
            let status = lock.get_mut(&id).unwrap();

            if let SubsystemHealth::Recovering { .. } = status.health {
                // Já em recuperação — não inicia nova rodada concorrente
                return Ok(());
            }

            status.recovery_count += 1;
            let att = status.recovery_count;
            status.health = SubsystemHealth::Recovering {
                attempt: att,
                started_at_ms: now_ms,
            };
            att
        };

        CrashDiagnosticsService::global().record(
            id.to_diagnostic_subsystem(),
            DiagnosticLevel::Warn,
            "subsystem_recovery_started",
            format!(
                "{{\"subsystem\":\"{:?}\",\"reason\":\"{}\",\"attempt\":{}}}",
                id, reason, attempt
            ),
        );

        self.emit_state_change(id, "recovering");

        // 2. Executa o handler isolado daquele subsistema
        let handler = {
            let lock = self.handlers.lock().unwrap();
            lock.get(&id).cloned()
        };

        let result = if let Some(h) = handler {
            h()
        } else {
            // Sem handler registrado: recuperação no-op considerada bem-sucedida
            Ok(())
        };

        // 3. Atualiza estado pós-recuperação
        let mut lock = self.subsystems.lock().unwrap();
        let status = lock.get_mut(&id).unwrap();

        match result {
            Ok(()) => {
                status.health = SubsystemHealth::Healthy;
                status.last_recovered_ms = Some(now_ms);

                CrashDiagnosticsService::global().record(
                    id.to_diagnostic_subsystem(),
                    DiagnosticLevel::Info,
                    "subsystem_recovered_successfully",
                    format!("{{\"subsystem\":\"{:?}\",\"attempt\":{}}}", id, attempt),
                );

                self.emit_state_change(id, "healthy");
                Ok(())
            }
            Err(e) => {
                status.health = SubsystemHealth::Failed {
                    error: e.clone(),
                    failed_at_ms: now_ms,
                };

                CrashDiagnosticsService::global().record(
                    id.to_diagnostic_subsystem(),
                    DiagnosticLevel::Error,
                    "subsystem_recovery_failed",
                    format!(
                        "{{\"subsystem\":\"{:?}\",\"attempt\":{},\"error\":\"{}\"}}",
                        id, attempt, e
                    ),
                );

                self.emit_state_change(id, "failed");
                Err(e)
            }
        }
    }

    fn emit_state_change(&self, id: SubsystemId, state: &str) {
        let lock = self.app_handle.lock().unwrap();
        if let Some(app) = lock.as_ref() {
            let payload = serde_json::json!({
                "subsystem": format!("{:?}", id),
                "state": state,
                "timestamp_ms": SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64,
            });
            let _ = app.emit("sf:subsystem-recovery", payload);
        }
    }

    /// Retorna o status de todos os subsistemas monitorados.
    pub fn get_all_statuses(&self) -> Vec<SubsystemStatus> {
        let lock = self.subsystems.lock().unwrap();
        lock.values().cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn test_device_recovery_subsystem_isolation_30_cycles() {
        let recovery = NativeDeviceRecoveryManager::new();
        let mic_recoveries = Arc::new(AtomicUsize::new(0));
        let graphics_recoveries = Arc::new(AtomicUsize::new(0));

        let mic_clone = mic_recoveries.clone();
        recovery.register_handler(SubsystemId::Microphone, move || {
            mic_clone.fetch_add(1, Ordering::SeqCst);
            Ok(())
        });

        let gfx_clone = graphics_recoveries.clone();
        recovery.register_handler(SubsystemId::GraphicsContext, move || {
            gfx_clone.fetch_add(1, Ordering::SeqCst);
            Ok(())
        });

        // 30 ciclos de recuperação de microfone
        for i in 0..30 {
            let res = recovery.trigger_recovery(SubsystemId::Microphone, &format!("test_disconnect_{}", i));
            assert!(res.is_ok());
        }

        // Valida isolamento estrito: 30 recuperações de mic NÃO devem afetar GraphicsContext
        assert_eq!(mic_recoveries.load(Ordering::SeqCst), 30);
        assert_eq!(
            graphics_recoveries.load(Ordering::SeqCst),
            0,
            "GraphicsContext must not be restarted by microphone recovery"
        );

        // Valida estado de saúde final
        let statuses = recovery.get_all_statuses();
        let mic_status = statuses.iter().find(|s| s.id == SubsystemId::Microphone).unwrap();
        match mic_status.health {
            SubsystemHealth::Healthy => (),
            _ => panic!("Microphone should be Healthy after recovery"),
        }
    }
}
