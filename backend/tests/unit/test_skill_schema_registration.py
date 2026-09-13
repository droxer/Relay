import json
import subprocess
import sys


def test_fresh_canonical_schema_import_registers_all_skill_tables():
    result = subprocess.run([
        sys.executable, "-c",
        "import json; from relay.persistence.schema import metadata; print(json.dumps(sorted(metadata.tables)))",
    ], capture_output=True, text=True, check=True)
    assert {"skills", "skill_revisions", "skill_files", "skill_blobs", "skill_events"} <= set(json.loads(result.stdout))
