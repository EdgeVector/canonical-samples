#!/usr/bin/env python3
"""Check the retained product sample JSON and its manifest without a live service."""

import argparse
import json
from pathlib import Path
import re


def object_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON field {key!r}")
        result[key] = value
    return result


def non_json_number(value):
    raise ValueError(f"non-JSON number {value}")


def read(path):
    return json.loads(path.read_text(), object_pairs_hook=object_pairs,
                      parse_constant=non_json_number)


def validate(root):
    manifest = read(root / "manifest.json")
    entries = manifest.get("schemas")
    if not isinstance(entries, list) or not entries:
        raise ValueError("manifest.schemas must be a nonempty list")
    expected = set()
    records = 0
    for entry in entries:
        name = entry.get("descriptive_name", "")
        if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z][A-Za-z0-9]*", name):
            raise ValueError("invalid manifest descriptive_name")
        filename = name + ".json"
        if filename in expected:
            raise ValueError(f"duplicate manifest sample {filename}")
        expected.add(filename)
        identity = entry.get("identity_hash", "")
        if not isinstance(identity, str) or not re.fullmatch(r"[0-9a-f]{64}", identity):
            raise ValueError(f"{filename}: invalid recorded identity_hash")
        count = entry.get("row_count")
        if type(count) is not int or count <= 0:
            raise ValueError(f"{filename}: row_count must be a positive integer")
        rows = read(root / "samples" / filename)
        if not isinstance(rows, list) or len(rows) != count:
            raise ValueError(f"{filename}: records do not match manifest row_count={count}")
        if any(not isinstance(row, dict) or not row for row in rows):
            raise ValueError(f"{filename}: each sample must be a nonempty record object")
        records += len(rows)
        print(f"{filename}: {len(rows)} records")
    actual = {path.name for path in (root / "samples").iterdir() if path.suffix == ".json"}
    if actual != expected:
        raise ValueError(f"sample membership differs: missing={sorted(expected - actual)}, "
                         f"unlisted={sorted(actual - expected)}")
    print(f"Validated JSON and manifest integrity: {len(expected)} files, {records} records")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    try:
        validate(args.root)
    except (OSError, ValueError, TypeError, AttributeError) as error:
        parser.exit(1, f"sample format error: {error}\n")


if __name__ == "__main__":
    main()
