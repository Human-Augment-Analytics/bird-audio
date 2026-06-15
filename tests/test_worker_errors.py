import json
import io
from birdpipe.worker import run_worker

class FakePipeline:
    def __init__(self):
        self.device = "cpu"
    def process_file(self, *args, **kwargs):
        return {"status": "error", "message": "open failed"}

def test_worker_maps_status_error_to_type_error():
    pipe = FakePipeline()
    in_s = io.StringIO(json.dumps({"id": 1, "input": "miss.wav"}) + "\n")
    out_s = io.StringIO()
    run_worker(pipe, in_s, out_s)
    out_s.seek(0)
    lines = [json.loads(l) for l in out_s if l.strip()]
    assert lines[1]["type"] == "error"
    assert lines[1]["message"] == "open failed"
