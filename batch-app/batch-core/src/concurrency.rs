//! Choose how many warm workers to run, by device (GPU=1, CPU=pool).

/// Resolve worker count. An explicit `requested` always wins (min 1).
/// Otherwise CUDA/MPS use a single warm worker; CPU uses cores-1 (min 1).
pub fn resolve_concurrency(device: &str, requested: Option<usize>) -> usize {
    if let Some(r) = requested {
        return r.max(1);
    }
    match device {
        "cuda" | "mps" => 1,
        _ => {
            let cores = std::thread::available_parallelism()
                .map(|n| n.get())
                .unwrap_or(4);
            cores.saturating_sub(1).max(1)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gpu_devices_use_single_worker() {
        assert_eq!(resolve_concurrency("cuda", None), 1);
        assert_eq!(resolve_concurrency("mps", None), 1);
    }

    #[test]
    fn explicit_request_overrides_and_is_at_least_one() {
        assert_eq!(resolve_concurrency("cuda", Some(4)), 4);
        assert_eq!(resolve_concurrency("cpu", Some(0)), 1);
    }

    #[test]
    fn cpu_pool_is_at_least_one() {
        assert!(resolve_concurrency("cpu", None) >= 1);
    }
}
