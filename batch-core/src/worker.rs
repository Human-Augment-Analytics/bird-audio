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
                        Ok(WorkerMsg::Ready { device }) => {
                            w.device = device;
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
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
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
