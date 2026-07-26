//! Serde types for the newline-delimited JSON worker protocol.

use serde::{Deserialize, Serialize};

/// One job request sent to a worker on stdin.
#[derive(Debug, Clone, Serialize)]
pub struct Request {
    pub id: u64,
    pub input: String,
    pub manifest_only: bool,
    pub theta_a: f64,
    pub theta_b: f64,
    pub emit_raw: bool,
    pub localizer: Option<String>,
    pub classifier: Option<String>,
    pub classifier_c: Option<String>,
    pub f_min_hz: Option<f64>,
    pub f_max_hz: Option<f64>,
    pub species_name: Option<String>,
}

/// One consolidated event record (mirrors Plan-1 `records.to_record`).
#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct EventRecord {
    pub t_start: f64,
    pub t_end: f64,
    pub duration: f64,
    pub f_low: f64,
    pub f_high: f64,
    pub center_freq: f64,
    pub stage_a_conf: f64,
    pub completeness_score: Option<f64>,
    pub completeness_label: Option<String>,
    pub retained: Option<bool>,
    pub n_members: i64,
    pub localizer: Option<String>,
    pub classifier: Option<String>,
    pub classifier_c: Option<String>,
    pub f_min_hz: Option<f64>,
    pub f_max_hz: Option<f64>,
    pub species_name: Option<String>,
    pub stage_c_label: Option<String>,
    pub stage_c_score: Option<f64>,
}

/// A line emitted by a worker on stdout. Unknown extra keys are ignored.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type")]
pub enum WorkerMsg {
    #[serde(rename = "ready")]
    Ready {
        device: String,
        /// Absent from older workers, and null when the worker could not build one.
        #[serde(default)]
        manifest: Option<serde_json::Value>,
    },
    #[serde(rename = "result")]
    Result {
        id: u64,
        #[serde(default)]
        input: String,
        #[serde(default)]
        n_windows: i64,
        #[serde(default)]
        n_raw: i64,
        #[serde(default)]
        n_events: i64,
        #[serde(default)]
        n_complete: i64,
        #[serde(default)]
        n_retained: i64,
        #[serde(default)]
        elapsed_ms: i64,
        #[serde(default)]
        events: Vec<EventRecord>,
    },
    #[serde(rename = "error")]
    Error {
        #[serde(default)]
        id: Option<u64>,
        #[serde(default)]
        input: Option<String>,
        message: String,
        #[serde(default)]
        traceback: Option<String>,
    },
}

/// Parse one stdout line into a WorkerMsg.
pub fn parse_msg(line: &str) -> serde_json::Result<WorkerMsg> {
    serde_json::from_str(line)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_serializes_with_exact_keys() {
        let req = Request {
            id: 123,
            input: "/a.WAV".into(),
            manifest_only: true,
            theta_a: 0.0,
            theta_b: 0.530306,
            emit_raw: false,
            localizer: None,
            classifier: None,
            classifier_c: None,
            f_min_hz: None,
            f_max_hz: None,
            species_name: None,
        };
        let v: serde_json::Value = serde_json::to_value(&req).unwrap();
        assert_eq!(v["id"], 123);
        assert_eq!(v["input"], "/a.WAV");
        assert_eq!(v["manifest_only"], true);
        assert_eq!(v["theta_b"], 0.530306);
        assert_eq!(v["emit_raw"], false);
    }

    #[test]
    fn parses_ready_without_manifest() {
        let m = parse_msg(r#"{"type":"ready","device":"cpu"}"#).unwrap();
        match m {
            WorkerMsg::Ready { device, manifest } => {
                assert_eq!(device, "cpu");
                assert!(manifest.is_none());
            }
            _ => panic!("expected Ready"),
        }
    }

    #[test]
    fn parses_ready_with_manifest_round_trip() {
        let line = r#"{"type":"ready","device":"mps","manifest":{"schema_version":1,"models":{"localizer":{"sha256":"abc"}},"constants":{"F_MIN_HZ":3000.0}}}"#;
        let m = parse_msg(line).unwrap();
        match m {
            WorkerMsg::Ready { device, manifest } => {
                assert_eq!(device, "mps");
                let v = manifest.expect("manifest present");
                assert_eq!(v["schema_version"], 1);
                assert_eq!(v["models"]["localizer"]["sha256"], "abc");
                let text = serde_json::to_string(&v).unwrap();
                let back: serde_json::Value = serde_json::from_str(&text).unwrap();
                assert_eq!(back, v);
            }
            _ => panic!("expected Ready"),
        }
    }

    #[test]
    fn parses_ready_with_null_manifest() {
        let m = parse_msg(r#"{"type":"ready","device":"cpu","manifest":null}"#).unwrap();
        match m {
            WorkerMsg::Ready { manifest, .. } => assert!(manifest.is_none()),
            _ => panic!("expected Ready"),
        }
    }

    #[test]
    fn parses_result_ignoring_unknown_keys() {
        let line = r#"{"type":"result","id":7,"status":"success","filename":"x.WAV","n_windows":10,"n_events":2,"elapsed_ms":50,"events":[{"t_start":1.0,"t_end":2.5,"duration":1.5,"f_low":5000,"f_high":6000,"center_freq":5500,"stage_a_conf":0.9,"completeness_score":0.8,"completeness_label":"complete","retained":true,"n_members":3}]}"#;
        let m = parse_msg(line).unwrap();
        match m {
            WorkerMsg::Result { id, n_events, events, .. } => {
                assert_eq!(id, 7);
                assert_eq!(n_events, 2);
                assert_eq!(events.len(), 1);
                assert_eq!(events[0].completeness_label.as_deref(), Some("complete"));
                assert_eq!(events[0].retained, Some(true));
            }
            _ => panic!("expected Result"),
        }
    }

    #[test]
    fn parses_error_with_optional_id() {
        let m = parse_msg(r#"{"type":"error","id":4,"input":"/b.WAV","message":"boom"}"#).unwrap();
        match m {
            WorkerMsg::Error { id, message, .. } => {
                assert_eq!(id, Some(4));
                assert_eq!(message, "boom");
            }
            _ => panic!("expected Error"),
        }
    }
}
