"""Checks newcombe_paired in sim_min_n.py against the method-10 rows of Table III in
Newcombe (1998), Statistics in Medicine 17:2635-2650. Run: python3 docs/decision/newcombe_check.py
Expected values are transcribed from the paper; exits 1 on any mismatch."""
import importlib.util
import pathlib
import sys

spec = importlib.util.spec_from_file_location("sim", pathlib.Path(__file__).with_name("sim_min_n.py"))
sim = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sim)

ROWS = [((36, 12, 2, 0), (0.0569, 0.3404)), ((20, 12, 2, 16), (0.0562, 0.3292)),
        ((18, 12, 2, 18), (0.0562, 0.3290)), ((36, 14, 0, 0), (0.1528, 0.4167)),
        ((35, 14, 0, 1), (0.1461, 0.4175)), ((18, 14, 0, 18), (0.1441, 0.3963)),
        ((2, 97, 1, 0), (0.8721, 0.9854))]
bad = 0
for (a, b, c, d), (lo_x, hi_x) in ROWS:
    _, lo, hi = sim.newcombe_paired(a, b, c, d)
    ok = abs(lo - lo_x) < 6e-5 and abs(hi - hi_x) < 6e-5
    bad += not ok
    print(f"{(a, b, c, d)} expected ({lo_x}, {hi_x}) got ({lo:.4f}, {hi:.4f}) {'OK' if ok else 'MISMATCH'}")
print(f"checked={len(ROWS)} mismatches={bad}")
sys.exit(1 if bad else 0)
