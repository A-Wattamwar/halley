"""
Sitecustomize shim: auto-imported by Python when this file's parent directory
is on PYTHONPATH as a sitecustomize.py (or when the directory is in site-packages).

The halley CLI places this on PYTHONPATH to inject recording/replay without
modifying the user's agent code.
"""
import os

if os.environ.get("HALLEY_RECORD") == "1":
    from halley_sdk.recorder import patch
    patch()
