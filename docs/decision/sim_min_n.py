"""TokenMax minimum-evidence simulation (numpy + stdlib only). Seed fixed.
Part A: paired accept/reject decision rule, Newcombe paired Wilson interval and paired bootstrap.
Part B: bootstrap CI width of cost per accepted result when costs differ 100x.
ASSUMPTION (not from data): Jev and LLM outcomes on the same case are correlated via a
Gaussian copula with latent correlation RHO. Both 0.0 and 0.5 are run.
"""
import numpy as np
from statistics import NormalDist

SEED = 20260929
NS = [10, 20, 30, 50, 100]
PLLM = [0.8, 0.9]
DROPS = [0.0, 0.05, 0.10]
MARGINS = [0.05, 0.10]
RHOS = [0.0, 0.5]
REPS = 2000
NBOOT = 1000
Z = 1.959964
ND = NormalDist()


def wilson(k, n):
    p = k / n
    d = 1 + Z * Z / n
    c = (p + Z * Z / (2 * n)) / d
    h = Z * np.sqrt(p * (1 - p) / n + Z * Z / (4 * n * n)) / d
    return p, c - h, c + h


def newcombe_paired(a, b, c, d):
    """a both accept, b jev only, c llm only, d neither. Returns (diff, lo, hi) for p_jev - p_llm."""
    n = a + b + c + d
    p1, l1, u1 = wilson(a + b, n)
    p2, l2, u2 = wilson(a + c, n)
    A = (a + b) * (a + c) * (c + d) * (b + d)
    B = a * d - b * c
    if B > 0:
        C = 0.0 if B <= n / 2 else B - n / 2
    else:
        C = B
    phi = C / np.sqrt(A) if A > 0 else 0.0
    D = p1 - p2
    lo = D - np.sqrt((p1 - l1) ** 2 + (u2 - p2) ** 2 - 2 * phi * (p1 - l1) * (u2 - p2))
    hi = D + np.sqrt((u1 - p1) ** 2 + (p2 - l2) ** 2 - 2 * phi * (u1 - p1) * (p2 - l2))
    return D, lo, hi


def boot_paired(rng, a, b, c, d):
    n = a + b + c + d
    cnt = rng.multinomial(n, np.array([a, b, c, d]) / n, size=NBOOT)
    diff = (cnt[:, 1] - cnt[:, 2]) / n
    return np.percentile(diff, [2.5, 97.5])


def gen_cases(rng, n, p_llm, p_jev, rho):
    z1 = rng.standard_normal(n)
    z2 = rho * z1 + np.sqrt(1 - rho * rho) * rng.standard_normal(n)
    jev = z1 < ND.inv_cdf(p_jev)
    llm = z2 < ND.inv_cdf(p_llm)
    return jev, llm


def decide(lo, hi, X):
    if lo > -X:
        return "ok"
    if hi < -X:
        return "reject"
    return "nee"


def part_a():
    rng = np.random.default_rng(SEED)
    for rho in RHOS:
        for X in MARGINS:
            print(f"\n== PART A  rho={rho}  margin X={X:.2f}  reps={REPS}  (cells: %ok / %reject / %not-enough)")
            for method in ("newcombe", "bootstrap"):
                print(f"-- interval = {method}")
                print("p_llm  drop |" + "".join(f"  n={n:<3d}          " for n in NS))
                for pl in PLLM:
                    for d in DROPS:
                        row = []
                        for n in NS:
                            res = {"ok": 0, "reject": 0, "nee": 0}
                            reps = REPS if method == "newcombe" else 400
                            for _ in range(reps):
                                jev, llm = gen_cases(rng, n, pl, pl - d, rho)
                                a = int(np.sum(jev & llm)); b = int(np.sum(jev & ~llm))
                                c = int(np.sum(~jev & llm)); dd = n - a - b - c
                                if method == "newcombe":
                                    _, lo, hi = newcombe_paired(a, b, c, dd)
                                else:
                                    lo, hi = boot_paired(rng, a, b, c, dd)
                                res[decide(lo, hi, X)] += 1
                            row.append("%3.0f/%3.0f/%3.0f" % tuple(100 * res[k] / reps for k in ("ok", "reject", "nee")))
                        print(f"{pl:.1f}   {d:.2f} | " + "   ".join(row))


def part_b():
    rng = np.random.default_rng(SEED + 1)
    reps, nboot, sig = 300, 500, 0.5
    print("\n== PART B  cost per accepted, CI width as % of point estimate (median over reps)")
    print("LLM mean cost/call $0.01, Jev $0.0001 (100x), lognormal sigma 0.5, rho=0.5, Jev drop 0.05")
    print("cols: n | p_llm | LLM width% | Jev width% | ratio(LLM/Jev) width% | %reps Jev has <=2 accepts")
    for pl in PLLM:
        for n in NS:
            wl, wj, wr, few = [], [], [], 0
            for _ in range(reps):
                jev, llm = gen_cases(rng, n, pl, pl - 0.05, 0.5)
                cl = 0.01 * rng.lognormal(-sig * sig / 2, sig, n)
                cj = 0.0001 * rng.lognormal(-sig * sig / 2, sig, n)
                if jev.sum() <= 2:
                    few += 1
                idx = rng.integers(0, n, (nboot, n))
                al, aj = llm[idx].sum(1), jev[idx].sum(1)
                tl, tj = cl[idx].sum(1), cj[idx].sum(1)
                ok = (al > 0) & (aj > 0)
                if ok.sum() < nboot * 0.5 or llm.sum() == 0 or jev.sum() == 0:
                    continue
                el, ej = tl[ok] / al[ok], tj[ok] / aj[ok]
                pt_l, pt_j = cl.sum() / llm.sum(), cj.sum() / jev.sum()
                wl.append((np.percentile(el, 97.5) - np.percentile(el, 2.5)) / pt_l * 100)
                wj.append((np.percentile(ej, 97.5) - np.percentile(ej, 2.5)) / pt_j * 100)
                r = el / ej
                wr.append((np.percentile(r, 97.5) - np.percentile(r, 2.5)) / (pt_l / pt_j) * 100)
            print(f"n={n:<3d} | {pl:.1f} | {np.median(wl):6.0f} | {np.median(wj):6.0f} | {np.median(wr):6.0f} | {100*few/reps:5.1f}")


if __name__ == "__main__":
    part_a()
    part_b()
