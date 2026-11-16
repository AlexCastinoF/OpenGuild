use crate::models::GsiStatusResponse;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

pub struct GsiService {
    listening: Arc<AtomicBool>,
    port: u16,
    last_received_at: Arc<AtomicU64>,
    last_snapshot: Arc<Mutex<Option<serde_json::Value>>>,
    shutdown_tx: Arc<Mutex<Option<tokio::sync::oneshot::Sender<()>>>>,
}

impl GsiService {
    pub fn new() -> Self {
        Self {
            listening: Arc::new(AtomicBool::new(false)),
            port: 39281,
            last_received_at: Arc::new(AtomicU64::new(0)),
            last_snapshot: Arc::new(Mutex::new(None)),
            shutdown_tx: Arc::new(Mutex::new(None)),
        }
    }

    pub fn status(&self) -> GsiStatusResponse {
        let is_listening = self.listening.load(Ordering::SeqCst);
        let last_rcv = self.last_received_at.load(Ordering::SeqCst);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        let receiving = last_rcv > 0 && (now.saturating_sub(last_rcv) < 15000);
        let waiting = is_listening && !receiving;
        let snap = self.last_snapshot.lock().unwrap().clone();

        GsiStatusResponse {
            ok: true,
            enabled: is_listening,
            listening: is_listening,
            port: self.port,
            auth_configured: true,
            receiving,
            waiting,
            error: String::new(),
            snapshot: snap,
        }
    }

    pub fn start(&self, app: AppHandle) -> Result<(), String> {
        if self.listening.load(Ordering::SeqCst) {
            return Ok(());
        }

        let port = self.port;
        let listening = self.listening.clone();
        let last_received = self.last_received_at.clone();
        let last_snapshot = self.last_snapshot.clone();

        let (tx, mut rx) = tokio::sync::oneshot::channel::<()>();
        *self.shutdown_tx.lock().unwrap() = Some(tx);

        listening.store(true, Ordering::SeqCst);

        tauri::async_runtime::spawn(async move {
            let addr = format!("127.0.0.1:{}", port);
            let listener = match TcpListener::bind(&addr).await {
                Ok(l) => {
                    log::info!("[GSI] Listening on {}", addr);
                    l
                }
                Err(err) => {
                    log::error!("[GSI] Failed to bind {}: {}", addr, err);
                    listening.store(false, Ordering::SeqCst);
                    return;
                }
            };

            loop {
                tokio::select! {
                    _ = &mut rx => {
                        log::info!("[GSI] Shutting down listener");
                        break;
                    }
                    accept_res = listener.accept() => {
                        let (mut stream, _) = match accept_res {
                            Ok(res) => res,
                            Err(_) => continue,
                        };

                        let app_clone = app.clone();
                        let last_rcv = last_received.clone();
                        let last_snap = last_snapshot.clone();

                        tokio::spawn(async move {
                            let mut buf = vec![0u8; 65536];
                            let n = match stream.read(&mut buf).await {
                                Ok(n) if n > 0 => n,
                                _ => return,
                            };

                            let req_str = String::from_utf8_lossy(&buf[..n]);
                            if let Some(body_start) = req_str.find("\r\n\r\n") {
                                let body = &req_str[body_start + 4..];
                                if let Ok(val) = serde_json::from_str::<serde_json::Value>(body) {
                                    let now = std::time::SystemTime::now()
                                        .duration_since(std::time::UNIX_EPOCH)
                                        .unwrap_or_default()
                                        .as_millis() as u64;

                                    last_rcv.store(now, Ordering::SeqCst);
                                    *last_snap.lock().unwrap() = Some(val.clone());

                                    let _ = app_clone.emit("sf:gsi-update", val);
                                }
                            }

                            let response = "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
                            let _ = stream.write_all(response.as_bytes()).await;
                        });
                    }
                }
            }
            listening.store(false, Ordering::SeqCst);
        });

        Ok(())
    }

    pub fn stop(&self) {
        if let Some(tx) = self.shutdown_tx.lock().unwrap().take() {
            let _ = tx.send(());
        }
        self.listening.store(false, Ordering::SeqCst);
    }
}
