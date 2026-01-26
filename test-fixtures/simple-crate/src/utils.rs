use std::sync::atomic::{AtomicU64, Ordering};

static COUNTER: AtomicU64 = AtomicU64::new(1);

pub fn generate_id() -> u64 {
    COUNTER.fetch_add(1, Ordering::SeqCst)
}

pub fn format_name(name: &str) -> String {
    name.trim().to_lowercase()
}

pub struct Config {
    pub max_users: usize,
    pub timeout_ms: u64,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            max_users: 100,
            timeout_ms: 5000,
        }
    }
}
