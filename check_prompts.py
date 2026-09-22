#!/usr/bin/env python3
"""Check that prompts.json renders identically in both readers.

cards.js and reels.js fill {{name}} placeholders in JavaScript; eval_foundry.py
fills the same templates in Python. Two implementations of one substitution can
drift, and if they do the evaluation stops measuring what the app runs. This
renders every template with the same values in both and compares byte for byte.

    python check_prompts.py        # prints a line per template, exits 1 on any mismatch

Needs node on PATH. Standard library only.
"""

import json
import os
import subprocess
import sys

import eval_foundry as E

HERE = os.path.dirname(os.path.abspath(__file__))

# one value per placeholder used anywhere in prompts.json
SAMPLE = {
    "label": "Section A",
    "text": "the transcript text",
    "count": 4,
    "segment": "the source segment",
    "prompt": "What is X?",
    "answer": "X is Y.",
    "existing": "- an existing card",
    "typed": "the student's answer",
    "title": "A Video Title",
    "timed": "[12] a spoken line",
    "minSeconds": 20,
    "maxSeconds": 75,
}

RENDER_IN_NODE = """
const fs = require('fs');
const P = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
const vars = JSON.parse(process.argv[2]);
// the same fillTemplate cards.js uses
function fillTemplate(tpl, vars) {
  return String(tpl).replace(/\\{\\{(\\w+)\\}\\}/g, (whole, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : whole);
}
const out = {};
for (const key of Object.keys(P)) {
  if (key.startsWith('_')) continue;
  out[key] = { system: P[key].system, user: fillTemplate(P[key].user, vars) };
}
process.stdout.write(JSON.stringify(out));
"""


def main():
    keys = [k for k in E.PROMPTS if not k.startswith("_")]

    try:
        raw = subprocess.run(
            ["node", "-e", RENDER_IN_NODE, E.PROMPTS_PATH, json.dumps(SAMPLE)],
            capture_output=True, text=True, check=True,
        ).stdout
    except FileNotFoundError:
        sys.exit("node is not on PATH, so the JavaScript side cannot be rendered.")
    except subprocess.CalledProcessError as e:
        sys.exit(f"node failed: {e.stderr.strip()[:400]}")

    js = json.loads(raw)
    failures = 0

    for key in sorted(keys):
        spec = E.PROMPTS[key]
        mine = {"system": spec["system"], "user": E.fill_template(spec["user"], **SAMPLE)}
        theirs = js.get(key)
        ok = mine == theirs
        print(f"  {key:9s} {'match' if ok else 'MISMATCH'}")
        if not ok:
            failures += 1
            for field in ("system", "user"):
                if not theirs or mine[field] != theirs.get(field):
                    print(f"    {field} python: {mine[field][:120]!r}")
                    print(f"    {field} node  : {(theirs or {}).get(field, '')[:120]!r}")

    missing = sorted(set(keys) - set(js))
    for key in missing:
        print(f"  {key:9s} MISSING on the JavaScript side")
        failures += 1

    # an unfilled placeholder means the sample above has fallen behind a template
    for key in sorted(keys):
        rendered = E.fill_template(E.PROMPTS[key]["user"], **SAMPLE)
        if "{{" in rendered:
            leftover = rendered[rendered.index("{{"):][:40]
            print(f"  {key:9s} UNFILLED placeholder: {leftover!r} — add it to SAMPLE")
            failures += 1

    print(f"{len(keys) - failures}/{len(keys)} templates agree")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
