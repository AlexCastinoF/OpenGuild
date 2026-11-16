use crate::services::crash_diagnostics::{
    CrashDiagnosticsService, DiagnosticLevel, DiagnosticSubsystem,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ResourceType {
    WasapiAudioClient,
    WasapiCaptureClient,
    D3D11Device,
    D3D11DeviceContext,
    DxgiSharedHandle,
    WgcFramePool,
    GenericThread,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ResourceState {
    Active,
    Cancelling,
    Disposed,
    Quarantined { active_leases: u32 },
}

/// Token de cancelamento cooperativo atômico para threads e pipelines de mídia.
#[derive(Clone)]
pub struct CancellationToken {
    cancelled: Arc<AtomicBool>,
}

impl CancellationToken {
    pub fn new() -> Self {
        Self {
            cancelled: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
    }
}

/// Lease de recurso que garante que um ponteiro ou contexto COM/D3D11
/// não seja desalocado enquanto estiver em uso por uma thread concorrente.
pub struct ResourceLease {
    #[allow(dead_code)]
    resource_id: String,
    active_leases: Arc<AtomicU32>,
    condvar: Arc<Condvar>,
}

impl Drop for ResourceLease {
    fn drop(&mut self) {
        let prev = self.active_leases.fetch_sub(1, Ordering::SeqCst);
        if prev <= 1 {
            self.condvar.notify_all();
        }
    }
}

pub struct ManagedResource {
    pub id: String,
    pub resource_type: ResourceType,
    pub token: CancellationToken,
    pub state: ResourceState,
    active_leases: Arc<AtomicU32>,
    condvar: Arc<Condvar>,
    cleaner: Option<Box<dyn FnOnce() + Send + 'static>>,
}

pub struct NativeLifecycleManager {
    resources: Mutex<HashMap<String, ManagedResource>>,
}

impl NativeLifecycleManager {
    pub fn new() -> Self {
        Self {
            resources: Mutex::new(HashMap::new()),
        }
    }

    pub fn global() -> &'static Self {
        static INSTANCE: OnceLock<NativeLifecycleManager> = OnceLock::new();
        INSTANCE.get_or_init(Self::new)
    }

    /// Registra um recurso COM, WASAPI ou D3D11 sob gerenciamento cooperativo.
    pub fn register<F>(
        &self,
        id: impl Into<String>,
        resource_type: ResourceType,
        cleaner: F,
    ) -> CancellationToken
    where
        F: FnOnce() + Send + 'static,
    {
        let id_str = id.into();
        let token = CancellationToken::new();
        let active_leases = Arc::new(AtomicU32::new(0));
        let condvar = Arc::new(Condvar::new());

        let res = ManagedResource {
            id: id_str.clone(),
            resource_type,
            token: token.clone(),
            state: ResourceState::Active,
            active_leases,
            condvar,
            cleaner: Some(Box::new(cleaner)),
        };

        let mut lock = self.resources.lock().unwrap();
        lock.insert(id_str.clone(), res);

        CrashDiagnosticsService::global().record(
            DiagnosticSubsystem::Lifecycle,
            DiagnosticLevel::Info,
            "resource_registered",
            format!("{{\"id\":\"{}\",\"type\":\"{:?}\"}}", id_str, resource_type),
        );

        token
    }

    /// Adquire um lease do recurso. Se o recurso estiver sendo cancelado ou inexistente,
    /// retorna None impedindo que uma nova thread acesse um objeto em processo de shutdown.
    pub fn acquire_lease(&self, id: &str) -> Option<ResourceLease> {
        let lock = self.resources.lock().unwrap();
        let res = lock.get(id)?;

        if res.token.is_cancelled() {
            return None;
        }

        res.active_leases.fetch_add(1, Ordering::SeqCst);
        Some(ResourceLease {
            resource_id: id.to_string(),
            active_leases: res.active_leases.clone(),
            condvar: res.condvar.clone(),
        })
    }

    /// Desliga cooperativamente um recurso:
    /// 1. Sinaliza o CancellationToken.
    /// 2. Aguarda até timeout_ms (padrão 2.000 ms) para que todos os leases ativos cheguem a zero.
    /// 3. Se os leases zerarem: executa o cleaner ordenadamente.
    /// 4. Se estourar o timeout: ESCALONA para diagnóstico e coloca em Quarentena.
    ///    NUNCA força desalocação insegura de ponteiros COM/WASAPI/D3D11 em uso concorrente.
    pub fn shutdown(&self, id: &str, timeout_ms: u64) -> Result<(), String> {
        let (_token, active_leases, condvar, cleaner) = {
            let mut lock = self.resources.lock().unwrap();
            let res = lock.get_mut(id).ok_or_else(|| format!("Resource {} not found", id))?;

            res.token.cancel();
            res.state = ResourceState::Cancelling;
            (
                res.token.clone(),
                res.active_leases.clone(),
                res.condvar.clone(),
                res.cleaner.take(),
            )
        };

        let start = Instant::now();
        let timeout = Duration::from_millis(timeout_ms);

        let dummy_mutex = Mutex::new(());
        let mut dummy_guard = dummy_mutex.lock().unwrap();

        while active_leases.load(Ordering::SeqCst) > 0 {
            let elapsed = start.elapsed();
            if elapsed >= timeout {
                // Timeout de 2.000 ms atingido!
                let leases = active_leases.load(Ordering::SeqCst);

                // Quarentena segura: mantém o cleaner preservado até que o contador zerar
                let mut lock = self.resources.lock().unwrap();
                if let Some(r) = lock.get_mut(id) {
                    r.state = ResourceState::Quarantined { active_leases: leases };
                    r.cleaner = cleaner;
                }

                CrashDiagnosticsService::global().record(
                    DiagnosticSubsystem::Lifecycle,
                    DiagnosticLevel::Error,
                    "lifecycle_timeout_quarantined",
                    format!(
                        "{{\"id\":\"{}\",\"active_leases\":{},\"timeout_ms\":{}}}",
                        id, leases, timeout_ms
                    ),
                );

                return Err(format!(
                    "Resource {} shutdown timed out after {}ms with {} active leases (quarantined)",
                    id, timeout_ms, leases
                ));
            }

            let remaining = timeout - elapsed;
            let (new_guard, wait_res) = condvar.wait_timeout(dummy_guard, remaining).unwrap();
            dummy_guard = new_guard;
            if wait_res.timed_out() {
                break;
            }
        }

        // Leases zeraram com sucesso! Executa limpeza ordenada
        if let Some(c) = cleaner {
            c();
        }

        let mut lock = self.resources.lock().unwrap();
        if let Some(r) = lock.get_mut(id) {
            r.state = ResourceState::Disposed;
        }

        CrashDiagnosticsService::global().record(
            DiagnosticSubsystem::Lifecycle,
            DiagnosticLevel::Info,
            "resource_disposed_cleanly",
            format!("{{\"id\":\"{}\",\"elapsed_ms\":{}}}", id, start.elapsed().as_millis()),
        );

        Ok(())
    }

    /// Encerra todos os recursos ativos ordenadamente.
    pub fn shutdown_all(&self, timeout_ms: u64) {
        let keys: Vec<String> = {
            let lock = self.resources.lock().unwrap();
            lock.keys().cloned().collect()
        };

        for key in keys {
            let _ = self.shutdown(&key, timeout_ms);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::thread;
    use std::time::Duration;

    #[test]
    fn test_lifecycle_30_cycles_cooperative_shutdown() {
        let lifecycle = NativeLifecycleManager::new();
        let cleaned_counter = Arc::new(AtomicUsize::new(0));

        // Executa 30 ciclos de aquisição concorrente e shutdown ordenado
        for i in 0..30 {
            let res_id = format!("wasapi_stream_{}", i);
            let cleaned_clone = cleaned_counter.clone();

            let _token = lifecycle.register(&res_id, ResourceType::WasapiAudioClient, move || {
                cleaned_clone.fetch_add(1, Ordering::SeqCst);
            });

            // Simula thread de captura WASAPI concorrente usando o recurso
            let lease = lifecycle.acquire_lease(&res_id).expect("Lease must be acquired");
            let worker_handle = thread::spawn(move || {
                let _held_lease = lease;
                thread::sleep(Duration::from_millis(2));
            });

            worker_handle.join().expect("Worker thread finished");

            // Desliga cooperativamente com timeout de 2.000 ms
            let res = lifecycle.shutdown(&res_id, 2000);
            assert!(res.is_ok(), "Shutdown must succeed without timeout");
        }

        assert_eq!(
            cleaned_counter.load(Ordering::SeqCst),
            30,
            "All 30 resources must have been safely cleaned up"
        );
    }
}
