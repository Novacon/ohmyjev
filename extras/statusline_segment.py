"""ohmyjev statusline segment. Paste jev_segment() into your statusline script.

    jev = jev_segment(data.get("session_id"))   # data = the statusline JSON from stdin
    if jev:
        parts.append(jev)

Reads ~/.ohmyjev/sessions/<session_id>.json only: no subprocess, no network.
"""
import json
import os
import re
import time


def jev_segment(session_id):
    """'' without state for this session; else 'jev ✓23 ⛔1', 'jev ⚠ down' or 'jev ⚠ no key'."""
    home = os.environ.get("OHMYJEV_HOME") or os.path.expanduser("~/.ohmyjev")
    sid = re.sub(r"[^\w-]", "", str(session_id or ""))
    if not sid:
        return ""
    try:
        with open(os.path.join(home, "sessions", sid + ".json")) as f:
            s = json.load(f)
    except (OSError, ValueError):
        return ""
    if not isinstance(s, dict):
        return ""
    if s.get("noKey"):
        return "jev ⚠ no key"
    if s.get("downUntil", 0) > time.time() * 1000:
        return "jev ⚠ down"
    seg = "jev ✓%d" % s.get("calls", 0)
    return seg + (" ⛔%d" % s["denies"] if s.get("denies") else "")


if __name__ == "__main__":
    import tempfile

    with tempfile.TemporaryDirectory() as d:
        os.environ["OHMYJEV_HOME"] = d
        os.makedirs(os.path.join(d, "sessions"))
        assert jev_segment("s1") == "" and jev_segment(None) == ""
        path = os.path.join(d, "sessions", "evil.json")
        with open(path, "w") as f:
            json.dump({"calls": 23, "denies": 1, "downUntil": 0}, f)
        assert jev_segment("../../evil") == "jev ✓23 ⛔1"
        with open(path, "w") as f:
            json.dump({"calls": 3, "downUntil": (time.time() + 60) * 1000}, f)
        assert jev_segment("evil") == "jev ⚠ down"
        with open(path, "w") as f:
            json.dump({"noKey": True}, f)
        assert jev_segment("evil") == "jev ⚠ no key"
    print("ok")
