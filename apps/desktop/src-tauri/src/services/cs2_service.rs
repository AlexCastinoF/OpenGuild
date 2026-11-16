use std::process::{Child, Command};
use std::sync::{Arc, Mutex};

pub struct Cs2Service {
    dedicated_child: Arc<Mutex<Option<Child>>>,
}

impl Cs2Service {
    pub fn new() -> Self {
        Self {
            dedicated_child: Arc::new(Mutex::new(None)),
        }
    }

    pub fn open_cs2() -> Result<(), String> {
        #[cfg(target_os = "windows")]
        {
            Command::new("cmd")
                .args(["/c", "start", "steam://run/730"])
                .spawn()
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub fn connect_game(host: &str, port: u16, password: Option<&str>) -> Result<(), String> {
        let conn_str = if let Some(pwd) = password {
            if !pwd.is_empty() {
                format!("steam://connect/{}:{}?password={}", host, port, pwd)
            } else {
                format!("steam://connect/{}:{}", host, port)
            }
        } else {
            format!("steam://connect/{}:{}", host, port)
        };

        #[cfg(target_os = "windows")]
        {
            Command::new("cmd")
                .args(["/c", "start", &conn_str])
                .spawn()
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub fn is_dedicated_running(&self) -> bool {
        let mut guard = self.dedicated_child.lock().unwrap();
        if let Some(child) = guard.as_mut() {
            match child.try_wait() {
                Ok(None) => true,
                _ => {
                    *guard = None;
                    false
                }
            }
        } else {
            false
        }
    }

    pub fn stop_dedicated(&self) -> Result<(), String> {
        let mut guard = self.dedicated_child.lock().unwrap();
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
        }
        Ok(())
    }
}
