use serde::Serialize;
use std::fmt;

#[derive(Debug, Serialize)]
pub struct AppError {
    pub message: String,
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for AppError {}

impl From<std::io::Error> for AppError {
    fn from(err: std::io::Error) -> Self {
        AppError {
            message: err.to_string(),
        }
    }
}

impl From<serde_json::Error> for AppError {
    fn from(err: serde_json::Error) -> Self {
        AppError {
            message: err.to_string(),
        }
    }
}

impl From<String> for AppError {
    fn from(message: String) -> Self {
        AppError { message }
    }
}

impl From<&str> for AppError {
    fn from(message: &str) -> Self {
        AppError {
            message: message.to_string(),
        }
    }
}
