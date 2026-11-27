import json, os, sys

root, osname, group = sys.argv[1], sys.argv[2], sys.argv[3]
exe = ".exe" if osname == "windows" else ""
arms = {}
for arm in ("base", "head"):
    base = os.path.join(root, "bin", f"{osname}-{arm}")
    if osname == "macos":
        base = os.path.join(base, "x")
    arms[arm] = {"app": os.path.join(base, "cap-gpui" + exe), "cli": os.path.join(base, "cap" + exe)}
cases = ["cli_then_app", "app_then_cli", "delete"] if group == "pairing" else ["plain", "crash"]
print(json.dumps({"out": os.path.join(root, "out"), "work": os.path.join(root, "work"), "arms": arms,
                  "cases": cases, "pairs": 5, "pairs_cli_then_app": 3, "pairs_app_then_cli": 3,
                  "pairs_delete": 2}, indent=1))
