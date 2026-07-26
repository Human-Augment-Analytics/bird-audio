"""Effort-normalized elevational analysis of retained buzz events (manuscript P1/P2).

The manuscript states two falsifiable predictions -- buzz events are (P1) more
frequent and (P2) longer at lower elevations -- and reports only raw counts.
Raw counts cannot address P1: recorders differ in how many files they
contributed, so every abundance measure here is divided by effort_hours.

The unit of replication is the recorder, not the event. Events from one recorder
share sampling context and are not independent observations of elevation, so all
models are fitted on recorder-level rows.
"""
from __future__ import annotations

import csv
import math
import re
import sqlite3
from dataclasses import asdict, dataclass, field
from statistics import mean as _stat_mean
from statistics import median as _stat_median
from statistics import stdev as _stat_stdev
from typing import Dict, Iterable, List, Mapping, Optional, Sequence, Union

import numpy as np
from scipy import stats

# 15-minute AudioMoth recordings; matches the effort accounting in batch-core/src/export.rs.
DEFAULT_EFFORT_HOURS_PER_FILE = 0.25

ALPHA = 0.05
BAND_ORDER = ("Low", "Medium", "High")
UNASSIGNED_BAND = "Unassigned"

# Recorder-ID prefix convention: PSL* = Low, PSM* = Medium, PSH*/H* = High.
DEFAULT_BAND_PREFIXES: Dict[str, str] = {
    "PSL": "Low",
    "PSM": "Medium",
    "PSH": "High",
    "H": "High",
}

# Below three recorders the design matrix is rank-deficient; below four the
# residual df is 1 and no p-value is interpretable.
MIN_RECORDERS_FOR_FIT = 3
MIN_RECORDERS_FOR_VERDICT = 4

# Pearson dispersion above this makes Poisson standard errors anticonservative.
OVERDISPERSION_CUTOFF = 1.2

SUPPORTED = "SUPPORTED"
NOT_SUPPORTED = "NOT SUPPORTED"
INCONCLUSIVE = "INCONCLUSIVE"

P1_TEXT = "P1: buzz events occur more frequently at lower elevations"
P2_TEXT = "P2: buzz events are longer at lower elevations"

_DEVICE_RE = re.compile(r"PS[LMH]\d+|(?<![A-Za-z0-9])H\d+", re.IGNORECASE)

DbLike = Union[str, "sqlite3.Connection"]


# --------------------------------------------------------------------------
# small numeric helpers
# --------------------------------------------------------------------------

def _finite(value: Optional[float]) -> Optional[float]:
    """Map NaN/inf to None so results stay JSON-serializable."""
    if value is None:
        return None
    v = float(value)
    return v if math.isfinite(v) else None


def _mean(values: Sequence[float]) -> Optional[float]:
    vals = [float(v) for v in values if v is not None]
    return _finite(_stat_mean(vals)) if vals else None


def _median(values: Sequence[float]) -> Optional[float]:
    vals = [float(v) for v in values if v is not None]
    return _finite(_stat_median(vals)) if vals else None


def _sd(values: Sequence[float]) -> Optional[float]:
    vals = [float(v) for v in values if v is not None]
    if len(vals) < 2:
        return None
    return _finite(_stat_stdev(vals))


# --------------------------------------------------------------------------
# recorder / site identification
# --------------------------------------------------------------------------

def parse_recorder_id(path: Optional[str]) -> Optional[str]:
    """Extract the AudioMoth recorder ID from a file path.

    Mirrors `find_device_id` in batch-core/src/export.rs: leftmost match of
    `PS[LMH]<digits>`, or `H<digits>` at a non-alphanumeric boundary.
    """
    if not path:
        return None
    m = _DEVICE_RE.search(str(path))
    return m.group(0).upper() if m else None


def resolve_recorder_id(
    path: Optional[str],
    metadata: Optional[Mapping[str, Dict]] = None,
) -> Optional[str]:
    """Recorder ID for a path, falling back to a device_id listed in the metadata.

    Deployments that do not follow the PS*/H* filename convention can still be
    attributed by giving the metadata a device_id that appears in the path
    (longest match wins). Without this, such files are dropped from the effort
    denominator and every rate is wrong.
    """
    rid = parse_recorder_id(path)
    if rid or not metadata or not path:
        return rid
    haystack = str(path).upper()
    for device_id in sorted(metadata, key=len, reverse=True):
        key = str(device_id).upper()
        if key and key in haystack:
            return key
    return None


def elevation_band(
    recorder_id: Optional[str],
    prefix_map: Optional[Mapping[str, str]] = None,
) -> Optional[str]:
    """Map a recorder ID to an elevation band via its prefix.

    `prefix_map` overrides the PSL/PSM/PSH/H convention (longest prefix wins).
    """
    if not recorder_id:
        return None
    prefixes = DEFAULT_BAND_PREFIXES if prefix_map is None else prefix_map
    rid = str(recorder_id).upper()
    for prefix in sorted(prefixes, key=len, reverse=True):
        if rid.startswith(str(prefix).upper()):
            return prefixes[prefix]
    return None


def resolve_band(
    recorder_id: Optional[str],
    site_id: Optional[str] = None,
    declared_band: Optional[str] = None,
    prefix_map: Optional[Mapping[str, str]] = None,
) -> Optional[str]:
    """Band from an explicit column, else the recorder ID, else the site ID.

    Deployments often name sites (PSL01) by band while recorder IDs carry a
    serial or timestamp, so the site prefix is the last resort before dropping
    the recorder from band summaries.
    """
    if declared_band:
        return declared_band
    return elevation_band(recorder_id, prefix_map) or elevation_band(site_id, prefix_map)


# --------------------------------------------------------------------------
# database access
# --------------------------------------------------------------------------

_SELECT_EVENTS = """
    SELECT f.path AS path,
           e.id AS event_id,
           e.session_id AS session_id,
           e.file_id AS file_id,
           e.t_start, e.t_end, e.duration,
           e.f_low, e.f_high, e.center_freq,
           e.stage_a_conf, e.completeness_score, e.completeness_label,
           e.retained, e.n_members, e.review_status, e.source
    FROM events e
    JOIN files f ON f.id = e.file_id
    WHERE (? IS NULL OR e.session_id = ?)
    ORDER BY f.path, e.t_start
"""


def _connect(db: DbLike):
    if isinstance(db, sqlite3.Connection):
        return db, False
    conn = sqlite3.connect(str(db))
    return conn, True


def _session_thetas(conn: sqlite3.Connection) -> Dict[int, Dict[str, float]]:
    cur = conn.execute("SELECT id, theta_a, theta_b FROM sessions")
    return {int(r[0]): {"theta_a": float(r[1]), "theta_b": float(r[2])} for r in cur.fetchall()}


def apply_thresholds(
    records: Iterable[Dict],
    theta_a: Optional[float] = None,
    theta_b: Optional[float] = None,
) -> List[Dict]:
    """Recompute completeness_label/retained from the raw scores.

    Retention rule matches birdpipe.records.finalize_events: retained iff
    stage_a_conf >= theta_a AND completeness_score >= theta_b, with a missing
    completeness score treated as 0.
    """
    out: List[Dict] = []
    for rec in records:
        r = dict(rec)
        ta = theta_a if theta_a is not None else r.get("session_theta_a")
        tb = theta_b if theta_b is not None else r.get("session_theta_b")
        if ta is None or tb is None:
            out.append(r)
            continue
        conf = r.get("stage_a_conf")
        conf = 0.0 if conf is None else float(conf)
        q = r.get("completeness_score")
        q = 0.0 if q is None else float(q)
        r["completeness_label"] = "complete" if q >= tb else "incomplete"
        r["retained"] = (conf >= ta) and (q >= tb)
        r["theta_a"] = ta
        r["theta_b"] = tb
        out.append(r)
    return out


def load_event_records(
    db_path: DbLike,
    session_id: Optional[int] = None,
    theta_a: Optional[float] = None,
    theta_b: Optional[float] = None,
) -> List[Dict]:
    """Load events joined to their file path.

    When theta_a/theta_b are supplied, `retained` is recomputed from the raw
    scores instead of trusting the stored column -- this is what makes threshold
    sweeps possible. When both are None the stored column is used as-is.
    """
    conn, owned = _connect(db_path)
    try:
        conn.row_factory = sqlite3.Row
        thetas = _session_thetas(conn)
        rows = conn.execute(_SELECT_EVENTS, (session_id, session_id)).fetchall()
    finally:
        if owned:
            conn.close()

    records: List[Dict] = []
    for row in rows:
        rec = dict(row)
        sess = thetas.get(int(rec["session_id"]), {})
        rec["session_theta_a"] = sess.get("theta_a")
        rec["session_theta_b"] = sess.get("theta_b")
        rec["theta_a"] = sess.get("theta_a")
        rec["theta_b"] = sess.get("theta_b")
        stored = rec.get("retained")
        rec["retained"] = bool(stored) if stored is not None else False
        rec["recorder_id"] = parse_recorder_id(rec.get("path"))
        records.append(rec)

    if theta_a is not None or theta_b is not None:
        records = apply_thresholds(records, theta_a, theta_b)
    return records


def session_thetas(db_path: DbLike, session_id: Optional[int] = None) -> Optional[Dict[str, float]]:
    """The thresholds a session was actually run with, used as the sweep baseline."""
    conn, owned = _connect(db_path)
    try:
        thetas = _session_thetas(conn)
    finally:
        if owned:
            conn.close()
    if not thetas:
        return None
    if session_id is not None:
        return thetas.get(int(session_id))
    return thetas[min(thetas)]


def load_file_paths(db_path: DbLike, session_id: Optional[int] = None) -> List[str]:
    """All enumerated file paths, including files that produced zero events.

    Files with no retained events still contribute effort; dropping them would
    inflate every rate_per_hour.
    """
    conn, owned = _connect(db_path)
    try:
        rows = conn.execute(
            "SELECT path FROM files WHERE (? IS NULL OR session_id = ?) ORDER BY path",
            (session_id, session_id),
        ).fetchall()
    finally:
        if owned:
            conn.close()
    return [r[0] for r in rows]


# --------------------------------------------------------------------------
# deployment metadata
# --------------------------------------------------------------------------

def read_deployment_metadata(metadata_csv: str) -> Dict[str, Dict]:
    """Parse a deployment CSV keyed by device_id.

    Columns follow batch-core/src/export.rs: device_id, site_id, elevation_m,
    lat, lon, deploy_date. Unlike the Rust exporter, a missing numeric field
    becomes None rather than 0.0 -- a 0 m elevation would silently corrupt a
    regression. An optional elevation_band column overrides the prefix
    convention.
    """
    table: Dict[str, Dict] = {}
    with open(metadata_csv, newline="", encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        for raw in reader:
            row = {
                (k or "").strip().strip('"').lower(): (v or "").strip().strip('"')
                for k, v in raw.items()
                if k is not None
            }
            device_id = row.get("device_id", "")
            if not device_id:
                continue

            def _num(name):
                try:
                    return float(row[name])
                except (KeyError, TypeError, ValueError):
                    return None

            band = row.get("elevation_band") or row.get("band") or None
            table[device_id.upper()] = {
                "device_id": device_id.upper(),
                "site_id": row.get("site_id") or None,
                "elevation_m": _num("elevation_m"),
                "lat": _num("lat"),
                "lon": _num("lon"),
                "deploy_date": row.get("deploy_date") or None,
                "elevation_band": band,
            }
    return table


def join_deployment_metadata(
    records: Iterable[Dict],
    metadata_csv: Optional[str] = None,
    prefix_map: Optional[Mapping[str, str]] = None,
    metadata: Optional[Mapping[str, Dict]] = None,
) -> List[Dict]:
    """Attach site_id, elevation_m, lat, lon and elevation_band to each record."""
    table = metadata if metadata is not None else (
        read_deployment_metadata(metadata_csv) if metadata_csv else {}
    )
    out: List[Dict] = []
    for rec in records:
        r = dict(rec)
        rid = resolve_recorder_id(r.get("path"), table)
        r["recorder_id"] = rid
        meta = table.get(rid.upper()) if rid else None
        r["site_id"] = meta.get("site_id") if meta else None
        r["elevation_m"] = meta.get("elevation_m") if meta else None
        r["lat"] = meta.get("lat") if meta else None
        r["lon"] = meta.get("lon") if meta else None
        r["elevation_band"] = resolve_band(
            rid, r["site_id"], meta.get("elevation_band") if meta else None, prefix_map
        )
        out.append(r)
    return out


def metadata_by_recorder(
    metadata: Mapping[str, Dict],
    prefix_map: Optional[Mapping[str, str]] = None,
) -> Dict[str, Dict]:
    """Reshape a device_id-keyed metadata table into recorder rows with bands."""
    out: Dict[str, Dict] = {}
    for device_id, meta in metadata.items():
        rid = str(device_id).upper()
        row = dict(meta)
        row["elevation_band"] = resolve_band(
            rid, meta.get("site_id"), meta.get("elevation_band"), prefix_map
        )
        out[rid] = row
    return out


# --------------------------------------------------------------------------
# summaries
# --------------------------------------------------------------------------

def measure_effort_hours(
    paths: Iterable[str],
    default_hours: float = DEFAULT_EFFORT_HOURS_PER_FILE,
) -> Dict[str, object]:
    """Per-file survey effort read from audio headers rather than assumed.

    A uniform per-file assumption biases every rate whenever recordings differ in
    length — truncated files from a full SD card or a flat battery are common in
    passive acoustic monitoring. Files that cannot be read fall back to
    `default_hours` and are counted in `n_defaulted` so the caller can report it.
    """
    try:
        import soundfile as sf
    except ImportError:
        return {
            "hours": {p: float(default_hours) for p in paths},
            "n_measured": 0,
            "n_defaulted": None,
            "available": False,
        }

    hours: Dict[str, float] = {}
    measured = 0
    defaulted = 0
    for path in paths:
        try:
            hours[path] = float(sf.info(path).duration) / 3600.0
            measured += 1
        except (RuntimeError, OSError):
            hours[path] = float(default_hours)
            defaulted += 1
    return {
        "hours": hours,
        "n_measured": measured,
        "n_defaulted": defaulted,
        "available": True,
    }


def recorder_summary(
    records: Iterable[Dict],
    effort_hours_per_file: float = DEFAULT_EFFORT_HOURS_PER_FILE,
    file_paths: Optional[Iterable[str]] = None,
    retained_only: bool = True,
    prefix_map: Optional[Mapping[str, str]] = None,
    metadata: Optional[Mapping[str, Dict]] = None,
    effort_by_path: Optional[Mapping[str, float]] = None,
) -> List[Dict]:
    """One row per recorder, with the effort-normalized rate the manuscript lacks.

    `file_paths` should list every enumerated file so that recorders which
    produced zero retained events still contribute effort and appear as
    zero-rate rows; omitting them biases P1 against low-detection sites.
    """
    recs = [dict(r) for r in records]
    if retained_only:
        recs = [r for r in recs if r.get("retained")]

    paths = list(file_paths) if file_paths is not None else sorted(
        {r["path"] for r in records if r.get("path")}
    )

    files_by_recorder: Dict[Optional[str], set] = {}
    for p in paths:
        files_by_recorder.setdefault(resolve_recorder_id(p, metadata), set()).add(p)

    events_by_recorder: Dict[Optional[str], List[Dict]] = {}
    for r in recs:
        rid = r.get("recorder_id") or resolve_recorder_id(r.get("path"), metadata)
        events_by_recorder.setdefault(rid, []).append(r)

    recorder_ids = sorted(
        set(files_by_recorder) | set(events_by_recorder),
        key=lambda v: (v is None, v or ""),
    )

    rows: List[Dict] = []
    for rid in recorder_ids:
        evs = events_by_recorder.get(rid, [])
        recorder_files = files_by_recorder.get(rid, ())
        n_files = len(recorder_files)
        if effort_by_path:
            effort = sum(
                float(effort_by_path.get(p, effort_hours_per_file)) for p in recorder_files
            )
        else:
            effort = n_files * float(effort_hours_per_file)
        durations = [e["duration"] for e in evs if e.get("duration") is not None]
        freqs = [e["center_freq"] for e in evs if e.get("center_freq") is not None]

        meta = (metadata or {}).get(rid.upper()) if rid else None
        site_id = meta.get("site_id") if meta else None
        elev = meta.get("elevation_m") if meta else None
        declared_band = meta.get("elevation_band") if meta else None
        for e in evs:
            site_id = e.get("site_id") or site_id
            if e.get("elevation_m") is not None:
                elev = e["elevation_m"]
            declared_band = e.get("elevation_band") or declared_band
        band = resolve_band(rid, site_id, declared_band, prefix_map)

        rows.append({
            "recorder_id": rid,
            "site_id": site_id,
            "elevation_m": _finite(elev) if elev is not None else None,
            "elevation_band": band,
            "n_files": n_files,
            "effort_hours": effort,
            "n_events": len(evs),
            "rate_per_hour": (len(evs) / effort) if effort > 0 else None,
            "duration_mean": _mean(durations),
            "duration_median": _median(durations),
            "duration_sd": _sd(durations),
            "center_freq_mean": _mean(freqs),
        })
    return rows


def band_summary(recorder_rows: Iterable[Dict]) -> List[Dict]:
    """Aggregate recorder-level means within each elevation band.

    The recorder, not the event, is the replicate: every mean/SD below is taken
    across recorder summaries.
    """
    groups: Dict[str, List[Dict]] = {}
    for row in recorder_rows:
        band = row.get("elevation_band") or UNASSIGNED_BAND
        groups.setdefault(band, []).append(row)

    ordered = [b for b in BAND_ORDER if b in groups]
    ordered += sorted(b for b in groups if b not in BAND_ORDER and b != UNASSIGNED_BAND)
    if UNASSIGNED_BAND in groups:
        ordered.append(UNASSIGNED_BAND)

    out: List[Dict] = []
    for band in ordered:
        rows = groups[band]
        rates = [r["rate_per_hour"] for r in rows if r.get("rate_per_hour") is not None]
        counts = [r["n_events"] for r in rows]
        out.append({
            "elevation_band": band,
            "n_recorders": len(rows),
            "n_files": sum(r["n_files"] for r in rows),
            "effort_hours": sum(r["effort_hours"] for r in rows),
            "n_events": sum(counts),
            "events_median_per_recorder": _median(counts),
            "rate_per_hour_mean": _mean(rates),
            "rate_per_hour_sd": _sd(rates),
            "rate_per_hour_median": _median(rates),
            "duration_mean": _mean([r["duration_mean"] for r in rows]),
            "duration_sd": _sd([r["duration_mean"] for r in rows]),
            "center_freq_mean": _mean([r["center_freq_mean"] for r in rows]),
            "center_freq_sd": _sd([r["center_freq_mean"] for r in rows]),
            "elevation_m_mean": _mean([r["elevation_m"] for r in rows]),
        })
    return out


def band_rate_ordering(band_rows: Iterable[Dict]) -> str:
    """Bands ranked by mean effort-normalized rate, highest first (e.g. 'Medium>Low>High')."""
    ranked = [
        r for r in band_rows
        if r.get("elevation_band") in BAND_ORDER and r.get("rate_per_hour_mean") is not None
    ]
    ranked.sort(key=lambda r: -r["rate_per_hour_mean"])
    return ">".join(r["elevation_band"] for r in ranked)


# --------------------------------------------------------------------------
# model results
# --------------------------------------------------------------------------

@dataclass
class ModelResult:
    prediction: str
    predictor: str
    response: str
    model: str
    estimate: Optional[float]
    se: Optional[float]
    ci_low: Optional[float]
    ci_high: Optional[float]
    p_value: Optional[float]
    n: int
    status: str
    direction: str
    verdict: str
    extra: Dict = field(default_factory=dict)
    notes: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict:
        return asdict(self)


def _direction(estimate: Optional[float]) -> str:
    if estimate is None or not math.isfinite(estimate):
        return "undetermined"
    if estimate < 0:
        return "negative (decreases with elevation)"
    if estimate > 0:
        return "positive (increases with elevation)"
    return "flat (no change with elevation)"


def _decide(
    estimate: Optional[float],
    p_value: Optional[float],
    n: int,
    alpha: float,
    expect_negative: bool = True,
) -> str:
    """Verdict at `alpha`. Non-significance is INCONCLUSIVE, not evidence of no effect."""
    if estimate is None or p_value is None or not math.isfinite(estimate):
        return INCONCLUSIVE
    if n < MIN_RECORDERS_FOR_VERDICT:
        return INCONCLUSIVE
    if p_value >= alpha:
        return INCONCLUSIVE
    predicted_sign = -1.0 if expect_negative else 1.0
    return SUPPORTED if estimate * predicted_sign > 0 else NOT_SUPPORTED


def _sentence(
    status: str,
    prediction: str,
    model: str,
    estimate: Optional[float],
    p_value: Optional[float],
    n: int,
    unit: str,
    notes: Sequence[str] = (),
) -> str:
    est = "n/a" if estimate is None else "{:+.6g}".format(estimate)
    pv = "n/a" if p_value is None else "{:.4g}".format(p_value)
    parts = [
        "{}: {}.".format(status, prediction),
        "{} slope = {} {} (p = {}, n = {} recorders).".format(model, est, unit, pv, n),
    ]
    if status == INCONCLUSIVE:
        parts.append("A non-significant or unfittable result is not evidence of no effect.")
    parts.extend(notes)
    return " ".join(parts)


def _inconclusive(
    prediction: str,
    predictor: str,
    response: str,
    model: str,
    n: int,
    reason: str,
) -> ModelResult:
    return ModelResult(
        prediction=prediction,
        predictor=predictor,
        response=response,
        model=model,
        estimate=None,
        se=None,
        ci_low=None,
        ci_high=None,
        p_value=None,
        n=n,
        status=INCONCLUSIVE,
        direction="undetermined",
        verdict="{}: {}. Model not fitted ({}), n = {} recorders.".format(
            INCONCLUSIVE, prediction, reason, n
        ),
        notes=[reason],
    )


# --------------------------------------------------------------------------
# estimators (scipy/numpy only -- statsmodels is not a dependency)
# --------------------------------------------------------------------------

def poisson_log_offset_fit(
    y: Sequence[float],
    x: Sequence[float],
    effort_hours: Sequence[float],
    max_iter: int = 200,
    tol: float = 1e-11,
):
    """Poisson GLM `y ~ 1 + x` with offset log(effort), fitted by IRLS.

    Returns (beta, cov, mu, dispersion). `x` is centered internally for
    conditioning; centering leaves the slope and its SE unchanged.
    """
    y = np.asarray(y, dtype=float)
    x = np.asarray(x, dtype=float)
    offset = np.log(np.asarray(effort_hours, dtype=float))
    xc = x - x.mean()
    X = np.column_stack([np.ones_like(xc), xc])

    total_effort = float(np.exp(offset).sum())
    start = math.log(max(float(y.sum()), 0.5) / max(total_effort, 1e-9))
    beta = np.array([start, 0.0], dtype=float)

    xtwx = None
    for _ in range(max_iter):
        eta = X @ beta + offset
        mu = np.exp(np.clip(eta, -700.0, 700.0))
        w = np.maximum(mu, 1e-12)
        z = X @ beta + (y - mu) / w
        WX = X * w[:, None]
        xtwx = X.T @ WX
        new = np.linalg.solve(xtwx, WX.T @ z)
        delta = float(np.max(np.abs(new - beta)))
        beta = new
        if delta < tol:
            break

    eta = X @ beta + offset
    mu = np.exp(np.clip(eta, -700.0, 700.0))
    w = np.maximum(mu, 1e-12)
    xtwx = X.T @ (X * w[:, None])
    cov = np.linalg.inv(xtwx)

    df = max(len(y) - X.shape[1], 1)
    dispersion = float(np.sum((y - mu) ** 2 / np.maximum(mu, 1e-12)) / df)
    return beta, cov, mu, dispersion


def weighted_least_squares(y: Sequence[float], x: Sequence[float], w: Sequence[float]):
    """WLS `y ~ 1 + x`. Returns (beta, cov, r2, sigma2)."""
    y = np.asarray(y, dtype=float)
    x = np.asarray(x, dtype=float)
    w = np.asarray(w, dtype=float)
    xc = x - x.mean()
    X = np.column_stack([np.ones_like(xc), xc])

    XtW = X.T * w
    xtwx = XtW @ X
    beta = np.linalg.solve(xtwx, XtW @ y)
    resid = y - X @ beta
    n, p = len(y), X.shape[1]
    sigma2 = float(np.sum(w * resid ** 2) / max(n - p, 1))
    cov = sigma2 * np.linalg.inv(xtwx)

    wsum = float(w.sum())
    ybar = float((w * y).sum() / wsum) if wsum > 0 else float(y.mean())
    ss_tot = float(np.sum(w * (y - ybar) ** 2))
    ss_res = float(np.sum(w * resid ** 2))
    r2 = (1.0 - ss_res / ss_tot) if ss_tot > 0 else None
    return beta, cov, r2, sigma2


def _spearman(
    prediction: str,
    response: str,
    x: Sequence[float],
    y: Sequence[float],
    alpha: float,
) -> ModelResult:
    n = len(x)
    if n < MIN_RECORDERS_FOR_FIT or len(set(map(float, x))) < 2 or len(set(map(float, y))) < 2:
        return _inconclusive(
            prediction, "elevation_m", response, "Spearman rank correlation", n,
            "fewer than {} recorders with variation in both variables".format(MIN_RECORDERS_FOR_FIT),
        )
    rho, p = stats.spearmanr(np.asarray(x, dtype=float), np.asarray(y, dtype=float))
    rho, p = _finite(rho), _finite(p)
    status = _decide(rho, p, n, alpha, expect_negative=True)
    return ModelResult(
        prediction=prediction,
        predictor="elevation_m",
        response=response,
        model="Spearman rank correlation",
        estimate=rho,
        se=None,
        ci_low=None,
        ci_high=None,
        p_value=p,
        n=n,
        status=status,
        direction=_direction(rho),
        verdict=_sentence(status, prediction, "Spearman rho", rho, p, n, "(rank correlation)"),
    )


# --------------------------------------------------------------------------
# P1 / P2
# --------------------------------------------------------------------------

def _usable_rows(recorder_rows: Iterable[Dict]) -> List[Dict]:
    return [
        r for r in recorder_rows
        if r.get("elevation_m") is not None and (r.get("effort_hours") or 0) > 0
    ]


def fit_p1_rate(recorder_rows: Iterable[Dict], alpha: float = ALPHA) -> Dict:
    """P1: event count vs elevation, with a log-effort offset."""
    rows = _usable_rows(recorder_rows)
    n = len(rows)
    elev = [float(r["elevation_m"]) for r in rows]
    counts = [float(r["n_events"]) for r in rows]
    effort = [float(r["effort_hours"]) for r in rows]
    rates = [float(r["rate_per_hour"]) for r in rows]

    spearman = _spearman(P1_TEXT, "rate_per_hour", elev, rates, alpha)

    if n < MIN_RECORDERS_FOR_FIT or len(set(elev)) < 2:
        reason = "fewer than {} recorders with a known elevation".format(MIN_RECORDERS_FOR_FIT)
        poisson = _inconclusive(P1_TEXT, "elevation_m", "n_events", "Poisson GLM (log-effort offset)", n, reason)
        quasi = _inconclusive(P1_TEXT, "elevation_m", "n_events", "quasi-Poisson GLM (log-effort offset)", n, reason)
        return {
            "prediction": P1_TEXT,
            "n_recorders": n,
            "overdispersion": None,
            "preferred": "spearman",
            "primary": spearman.to_dict(),
            "models": {
                "poisson": poisson.to_dict(),
                "quasi_poisson": quasi.to_dict(),
                "spearman": spearman.to_dict(),
            },
        }

    try:
        beta, cov, mu, dispersion = poisson_log_offset_fit(counts, elev, effort)
    except (np.linalg.LinAlgError, ValueError) as exc:
        reason = "Poisson IRLS failed: {}".format(exc)
        poisson = _inconclusive(P1_TEXT, "elevation_m", "n_events", "Poisson GLM (log-effort offset)", n, reason)
        return {
            "prediction": P1_TEXT,
            "n_recorders": n,
            "overdispersion": None,
            "preferred": "spearman",
            "primary": spearman.to_dict(),
            "models": {"poisson": poisson.to_dict(), "spearman": spearman.to_dict()},
        }

    slope = float(beta[1])
    se = float(math.sqrt(max(cov[1, 1], 0.0)))
    zcrit = float(stats.norm.ppf(1.0 - alpha / 2.0))
    p_pois = _finite(2.0 * stats.norm.sf(abs(slope / se))) if se > 0 else None
    status_pois = _decide(slope, p_pois, n, alpha)
    poisson = ModelResult(
        prediction=P1_TEXT,
        predictor="elevation_m",
        response="n_events",
        model="Poisson GLM (log-effort offset)",
        estimate=slope,
        se=se,
        ci_low=_finite(slope - zcrit * se),
        ci_high=_finite(slope + zcrit * se),
        p_value=p_pois,
        n=n,
        status=status_pois,
        direction=_direction(slope),
        verdict=_sentence(
            status_pois, P1_TEXT, "Poisson log-rate", slope, p_pois, n,
            "per metre (log events/hour)",
        ),
        extra={
            "dispersion": _finite(dispersion),
            "rate_ratio_per_100m": _finite(math.exp(slope * 100.0)),
        },
    )

    # Overdispersed counts make Poisson SEs anticonservative; the quasi-Poisson
    # scale correction is the statsmodels-free stand-in for a negative binomial.
    se_q = se * math.sqrt(max(dispersion, 0.0))
    df = max(n - 2, 1)
    tcrit = float(stats.t.ppf(1.0 - alpha / 2.0, df))
    p_quasi = _finite(2.0 * stats.t.sf(abs(slope / se_q), df)) if se_q > 0 else None
    status_quasi = _decide(slope, p_quasi, n, alpha)
    quasi = ModelResult(
        prediction=P1_TEXT,
        predictor="elevation_m",
        response="n_events",
        model="quasi-Poisson GLM (log-effort offset)",
        estimate=slope,
        se=_finite(se_q),
        ci_low=_finite(slope - tcrit * se_q),
        ci_high=_finite(slope + tcrit * se_q),
        p_value=p_quasi,
        n=n,
        status=status_quasi,
        direction=_direction(slope),
        verdict=_sentence(
            status_quasi, P1_TEXT, "quasi-Poisson log-rate", slope, p_quasi, n,
            "per metre (log events/hour)",
            notes=["Pearson dispersion = {:.3g} on {} df.".format(dispersion, df)],
        ),
        extra={
            "dispersion": _finite(dispersion),
            "df": df,
            "rate_ratio_per_100m": _finite(math.exp(slope * 100.0)),
        },
    )

    overdispersed = dispersion > OVERDISPERSION_CUTOFF
    preferred = "quasi_poisson" if overdispersed else "poisson"
    primary = quasi if overdispersed else poisson
    return {
        "prediction": P1_TEXT,
        "n_recorders": n,
        "overdispersion": _finite(dispersion),
        "preferred": preferred,
        "preferred_reason": (
            "Pearson dispersion {:.3g} > {} -- Poisson SEs would be anticonservative".format(
                dispersion, OVERDISPERSION_CUTOFF)
            if overdispersed else
            "Pearson dispersion {:.3g} <= {} -- Poisson is adequate".format(
                dispersion, OVERDISPERSION_CUTOFF)
        ),
        "primary": primary.to_dict(),
        "models": {
            "poisson": poisson.to_dict(),
            "quasi_poisson": quasi.to_dict(),
            "spearman": spearman.to_dict(),
        },
    }


def fit_p2_duration(recorder_rows: Iterable[Dict], alpha: float = ALPHA) -> Dict:
    """P2: recorder-level mean duration vs elevation, weighted by events per recorder."""
    rows = [
        r for r in _usable_rows(recorder_rows)
        if r.get("duration_mean") is not None and (r.get("n_events") or 0) > 0
    ]
    n = len(rows)
    elev = [float(r["elevation_m"]) for r in rows]
    dur = [float(r["duration_mean"]) for r in rows]
    weights = [float(r["n_events"]) for r in rows]

    spearman = _spearman(P2_TEXT, "duration_mean", elev, dur, alpha)

    if n < MIN_RECORDERS_FOR_FIT or len(set(elev)) < 2:
        reason = "fewer than {} recorders with events and a known elevation".format(
            MIN_RECORDERS_FOR_FIT)
        wls = _inconclusive(P2_TEXT, "elevation_m", "duration_mean", "weighted least squares", n, reason)
        return {
            "prediction": P2_TEXT,
            "n_recorders": n,
            "primary": spearman.to_dict(),
            "models": {"wls": wls.to_dict(), "spearman": spearman.to_dict()},
        }

    try:
        beta, cov, r2, _ = weighted_least_squares(dur, elev, weights)
    except (np.linalg.LinAlgError, ValueError) as exc:
        wls = _inconclusive(
            P2_TEXT, "elevation_m", "duration_mean", "weighted least squares", n,
            "WLS failed: {}".format(exc),
        )
        return {
            "prediction": P2_TEXT,
            "n_recorders": n,
            "primary": spearman.to_dict(),
            "models": {"wls": wls.to_dict(), "spearman": spearman.to_dict()},
        }

    slope = float(beta[1])
    se = float(math.sqrt(max(cov[1, 1], 0.0)))
    df = max(n - 2, 1)
    tcrit = float(stats.t.ppf(1.0 - alpha / 2.0, df))
    p = _finite(2.0 * stats.t.sf(abs(slope / se), df)) if se > 0 else None
    status = _decide(slope, p, n, alpha)
    wls = ModelResult(
        prediction=P2_TEXT,
        predictor="elevation_m",
        response="duration_mean",
        model="weighted least squares (weights = n_events)",
        estimate=slope,
        se=se,
        ci_low=_finite(slope - tcrit * se),
        ci_high=_finite(slope + tcrit * se),
        p_value=p,
        n=n,
        status=status,
        direction=_direction(slope),
        verdict=_sentence(
            status, P2_TEXT, "WLS", slope, p, n, "seconds per metre",
            notes=["R2 = {}.".format("n/a" if r2 is None else "{:.4g}".format(r2))],
        ),
        extra={"r_squared": _finite(r2), "df": df, "seconds_per_100m": _finite(slope * 100.0)},
    )

    return {
        "prediction": P2_TEXT,
        "n_recorders": n,
        "primary": wls.to_dict(),
        "models": {"wls": wls.to_dict(), "spearman": spearman.to_dict()},
    }


def fit_elevation_models(recorder_rows: Iterable[Dict], alpha: float = ALPHA) -> Dict:
    """Fit and adjudicate both manuscript predictions on recorder-level rows."""
    rows = list(recorder_rows)
    usable = _usable_rows(rows)
    return {
        "alpha": alpha,
        "n_recorders_total": len(rows),
        "n_recorders_with_elevation": len(usable),
        "unit_of_replication": "recorder",
        "p1": fit_p1_rate(rows, alpha),
        "p2": fit_p2_duration(rows, alpha),
    }
