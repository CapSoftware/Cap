import json
import re
import sys
from pathlib import Path

rows = []
for generation in range(1, 21):
    files = list((Path(sys.argv[1]) / f"report-{generation}").glob("*.jsonl"))
    records = [json.loads(line) for file in files for line in file.read_text().splitlines()]
    records = [r for r in records if r["case"] == "export/instant/output/mp4/native"]
    assert len(records) == 1, (generation, records)
    record = records[0]
    offsets = {}
    for note in record["notes"]:
        match = re.match(r"(mic|system): (\d+) markers, spread ([\d.]+) ms, A/V offset ([+-][\d.]+) ms", note)
        if match:
            source, markers, spread, offset = match.groups()
            assert int(markers) == 11, note
            assert float(spread) <= 1, note
            offsets[source] = float(offset)
    assert offsets.keys() == {"mic", "system"}, (generation, offsets)
    error = offsets["system"] - offsets["mic"]
    assert abs(error) <= 1, (generation, offsets, error)
    assert record["outcome"] in {"pass", "xfail"}, (generation, record["outcome"])
    rows.append({"generation": generation, "offsets_ms": offsets, "inter_source_error_ms": error, "outcome": record["outcome"]})
print(json.dumps(rows, indent=2))
