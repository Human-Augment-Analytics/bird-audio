//! A long-lived worker subprocess speaking the newline-delimited JSON protocol.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};

use crate::protocol::{parse_msg, Request, WorkerMsg};

pub struct Worker {
    child: Child,
    stdin: ChildStdin,
    rx: Receiver<String>,
    pub device: String,
    /// Provenance the worker captured while loading its models; None for older workers.
    pub manifest: Option<serde_json::Value>,
}

#[derive(Debug)]
pub enum WorkerError {
    Spawn(std::io::Error),
    Io(std::io::Error),
    Timeout,
    Closed,
    Protocol(String),
}

impl Worker {
    /// Spawn `program args...` (optionally in `cwd`), capture stdin/stdout, read `ready`.
    pub fn spawn(
        program: &str,
        args: &[String],
        cwd: Option<&std::path::Path>,
    ) -> Result<Worker, WorkerError> {
        let mut cmd = Command::new(program);
        cmd.args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        if let Some(dir) = cwd {
            cmd.current_dir(dir);
        }
        // Put the worker in its own process group so that killing it also kills any
        // grandchildren (e.g. the python interpreter spawned by a `uv run` wrapper).
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        let mut child = cmd.spawn().map_err(WorkerError::Spawn)?;
        let stdin = child.stdin.take().ok_or(WorkerError::Closed)?;
        let stdout = child.stdout.take().ok_or(WorkerError::Closed)?;
        let (tx, rx) = mpsc::channel::<String>();
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                match line {
                    Ok(l) => {
                        if tx.send(l).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });
        let mut w = Worker {
            child,
            stdin,
            rx,
            device: String::new(),
            manifest: None,
        };

        let start = Instant::now();
        loop {
            if start.elapsed() > Duration::from_secs(180) {
                return Err(WorkerError::Timeout);
            }
            match w.rx.recv_timeout(Duration::from_millis(100)) {
                Ok(line) => {
                    if !line.trim().starts_with('{') {
                        continue; // Skip library logs
                    }
                    match parse_msg(&line) {
                        Ok(WorkerMsg::Ready { device, manifest }) => {
                            w.device = device;
                            w.manifest = manifest;
                            break;
                        }
                        Ok(other) => {
                            return Err(WorkerError::Protocol(format!(
                                "expected ready, got {:?}",
                                other
                            )))
                        }
                        Err(_) => continue, // Might be a partial JSON log, skip it
                    }
                }
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => return Err(WorkerError::Closed),
            }
        }

        Ok(w)
    }

    pub fn send(&mut self, req: &Request) -> Result<(), WorkerError> {
        let line = serde_json::to_string(req).map_err(|e| WorkerError::Protocol(e.to_string()))?;
        self.stdin.write_all(line.as_bytes()).map_err(WorkerError::Io)?;
        self.stdin.write_all(b"\n").map_err(WorkerError::Io)?;
        self.stdin.flush().map_err(WorkerError::Io)?;
        Ok(())
    }

    pub fn recv_timeout(&self, dur: Duration) -> Result<WorkerMsg, WorkerError> {
        match self.rx.recv_timeout(dur) {
            Ok(line) => parse_msg(&line).map_err(|e| WorkerError::Protocol(e.to_string())),
            Err(RecvTimeoutError::Timeout) => Err(WorkerError::Timeout),
            Err(RecvTimeoutError::Disconnected) => Err(WorkerError::Closed),
        }
    }

    pub fn kill(&mut self) {
        kill_process_tree(&mut self.child);
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        kill_process_tree(&mut self.child);
    }
}

/// Kill the worker and every process in its group, then reap it.
fn kill_process_tree(child: &mut Child) {
    #[cfg(unix)]
    {
        // The child was spawned as its own process-group leader, so its pid is the pgid.
        // SAFETY: killpg is a plain syscall wrapper; a stale pid only yields ESRCH.
        unsafe {
            libc::killpg(child.id() as libc::pid_t, libc::SIGKILL);
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_args() -> Vec<String> {
        vec![format!("{}/tests/fake_worker.py", env!("CARGO_MANIFEST_DIR"))]
    }

    fn req(id: u64, input: &str) -> Request {
        Request {
            id,
            input: input.into(),
            manifest_only: true,
            theta_a: 0.0,
            theta_b: 0.53,
            emit_raw: false,
            localizer: None,
            classifier: None,
            classifier_c: None,
            f_min_hz: None,
            f_max_hz: None,
            species_name: None,
        }
    }

    #[test]
    fn spawn_reads_ready_then_processes_job() {
        let mut w = Worker::spawn("python3", &fake_args(), None).unwrap();
        assert_eq!(w.device, "cpu");
        w.send(&req(1, "/x.wav")).unwrap();
        match w.recv_timeout(Duration::from_secs(15)).unwrap() {
            WorkerMsg::Result { id, n_events, .. } => {
                assert_eq!(id, 1);
                assert_eq!(n_events, 1);
            }
            other => panic!("unexpected: {:?}", other),
        }
    }

    #[cfg(unix)]
    #[test]
    fn kill_takes_down_grandchildren() {
        // Mimic a `uv run python …` wrapper: a shell that forks a long-lived sibling
        // process and then runs the real worker.
        let pid_file = std::env::temp_dir().join(format!("worker-kill-test-{}.pid", std::process::id()));
        let script = format!(
            "sleep 300 & echo $! > '{}'; exec python3 '{}'",
            pid_file.display(),
            fake_args()[0]
        );
        let mut w = Worker::spawn("sh", &["-c".to_string(), script], None).unwrap();
        let start = Instant::now();
        let orphan: i32 = loop {
            if let Ok(text) = std::fs::read_to_string(&pid_file) {
                if let Ok(pid) = text.trim().parse() {
                    break pid;
                }
            }
            assert!(start.elapsed() < Duration::from_secs(10), "pid file never written");
            thread::sleep(Duration::from_millis(20));
        };
        assert_eq!(unsafe { libc::kill(orphan, 0) }, 0, "sleep should be alive before kill");
        w.kill();
        let start = Instant::now();
        loop {
            // ESRCH once the process is gone; a zombie still answers kill(pid, 0) with 0,
            // but the sleep is reparented to init/launchd which reaps it promptly.
            if unsafe { libc::kill(orphan, 0) } != 0 {
                break;
            }
            assert!(start.elapsed() < Duration::from_secs(5), "grandchild survived kill()");
            thread::sleep(Duration::from_millis(20));
        }
        let _ = std::fs::remove_file(&pid_file);
    }

    #[test]
    fn bad_file_yields_error_message() {
        let mut w = Worker::spawn("python3", &fake_args(), None).unwrap();
        w.send(&req(2, "/BOOM.wav")).unwrap();
        match w.recv_timeout(Duration::from_secs(15)).unwrap() {
            WorkerMsg::Error { id, message, .. } => {
                assert_eq!(id, Some(2));
                assert_eq!(message, "boom");
            }
            other => panic!("unexpected: {:?}", other),
        }
    }

    #[test]
    fn hang_triggers_timeout() {
        let mut w = Worker::spawn("python3", &fake_args(), None).unwrap();
        w.send(&req(3, "/HANG.wav")).unwrap();
        assert!(matches!(w.recv_timeout(Duration::from_millis(300)), Err(WorkerError::Timeout)));
        w.kill();
    }
}
