//! Shared Tauri app state: the cancel flag of the currently-running session.

use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

#[derive(Default)]
pub struct AppState {
    pub cancel: Mutex<Option<Arc<AtomicBool>>>,
}
