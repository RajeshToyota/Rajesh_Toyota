#!/usr/bin/env python3
"""Generate the catalog / price-list / accessory / extended-warranty seed migration from the
dealership's source PDFs.

    python3 scripts/seed/build_master_seed.py \
        --price-lists "<dir with PRICE LIST 2026 UPDATED pdfs>" \
        --accessories "<dir with the TGA order form pdfs>" \
        --out supabase/migrations/20261024000002_master_data_seed.sql

Needs `pdftotext` (poppler-utils). Every price-list row is cross-checked against the list's own
"On Road" column and anything that does not reconcile is reported, so a TKM layout change shows up
here instead of as a wrong quote. Ids are deterministic (uuid5), so re-running the output is safe.
"""

import argparse
import os
import re
import subprocess
import sys
import uuid
from collections import Counter, defaultdict
from itertools import combinations

NS = uuid.UUID("6f1d7c1e-6f5b-4c55-9a5e-3c2c1f0b7a10")
STATE = "Rajasthan"


def uid(*parts):
    return str(uuid.uuid5(NS, "|".join(str(p) for p in parts)))


# ----------------------------------------------------------------------------- catalog config

# prefix -> (model name, segment, existing Phase 0 model id to reuse or None)
MODELS = {
    "FRN": ("Fortuner", "SUV", "00000000-0000-0000-0006-000000000002"),
    "IMV": ("Innova Crysta", "MUV", "00000000-0000-0000-0006-000000000001"),
    "INN": ("Innova Hycross", "MUV", None),
    "D22": ("Urban Cruiser Hyryder", "SUV", None),
    "D24": ("Glanza", "Hatchback", None),
    "D27": ("Urban Cruiser Taisor", "SUV", None),
    "A15": ("Rumion", "MUV", None),
    "A32": ("Urban Cruiser Ebella", "SUV", None),
    "CMR": ("Camry", "Sedan", None),
    "LCR": ("Land Cruiser 300", "SUV", None),
    "VEL": ("Vellfire", "MPV", None),
    "HLX": ("Hilux", "Pickup", None),
}

# Models whose price lists print only the 2-character suffix; allowed suffixes per model.
TWO_CHAR_SUFFIXES = {
    "FRN": {"BJ", "BI", "CI", "BK", "CK", "BM", "1L", "2L", "3L", "4L", "B7", "B8", "P6", "B5", "B6"},
    "IMV": {"IV", "IW", "I8", "I9", "IS", "IR", "IQ", "IU", "IT", "V0", "V1"},
    "HLX": {"XA", "XB", "XC"},
    "VEL": {"E4", "E5", "E6", "E7"},
}

# Which special paint a second, dearer row for the same suffix means when the row text is silent.
DEFAULT_SPECIAL_PAINT = {"D22": "dual_tone", "D27": "dual_tone", "A32": "dual_tone"}

# TKM colour codes per model, from "ALL MODEL SUFFIX & COLOR CODE - 05.06.26".
COLORS = {
    "040": ("Super White", "#F4F4F2"), "089": ("Platinum White Pearl", "#F2F0EA"),
    "090": ("Precious White Pearl", "#F1EFE8"), "1D6": ("Silver Metallic", "#B9BCBF"),
    "218": ("Attitude Black", "#151515"), "220": ("Sparkling Black Pearl", "#1B1B1F"),
    "221": ("Blackish Ageha Glass Flake", "#232327"), "202": ("Black", "#101010"),
    "4V8": ("Avant Garde Bronze", "#6E5A48"), "4W9": ("Phantom Brown", "#4E3F36"),
    "1L5": ("Precious Metal", "#7B7D80"), "3U5": ("Emotional Red", "#9E1B22"),
    "1G3": ("Grey Metallic", "#6C6F72"), "8X8": ("Dark Blue Metallic", "#1F2B44"),
    "1H5": ("Cement Grey", "#8D8E8A"), "1M2": ("Ash", "#9A9A97"),
    "2PS": ("Platinum White Pearl & Attitude Black", "#F2F0EA"),
    "2UE": ("Super White & Attitude Black", "#F4F4F2"),
    "2QY": ("Silver Metallic & Attitude Black", "#B9BCBF"),
    "08B": ("Platinum White Pearl & Midnight Black", "#F2F0EA"),
    "1LB": ("Precious Metal & Midnight Black", "#7B7D80"),
    "3UB": ("Emotional Red & Midnight Black", "#9E1B22"),
    "8XB": ("Dark Blue Metallic & Midnight Black", "#1F2B44"),
    "1HB": ("Cement Grey & Midnight Black", "#8D8E8A"),
    "ZHJ": ("Cafe White", "#F3F1EA"), "WBE": ("Enticing Silver", "#C2C5C8"),
    "WBF": ("Gaming Grey", "#5E6164"), "WBG": ("Sportin Red", "#B3121B"),
    "ZYA": ("Spunky Blue", "#2B5FA8"), "Z7Q": ("Iconic Grey", "#6D7073"),
    "ZQK": ("Rustic Brown", "#6B4B3A"), "Z1Q": ("Insta Blue", "#1F6FB2"),
    "WAJ": ("Speedy Blue", "#1E4F9C"), "ZAM": ("Midnight Black", "#121214"),
    "ZQD": ("Cave Black", "#1A1A1A"), "ZYE": ("Lucent Orange", "#E06A1B"),
    "WB3": ("Bluish Black", "#1B2230"),
    "C9J": ("Cafe White & Midnight Black", "#F3F1EA"),
    "ERD": ("Enticing Silver & Midnight Black", "#C2C5C8"),
    "ESL": ("Sportin Red & Midnight Black", "#B3121B"),
    "ESY": ("Speedy Blue & Midnight Black", "#1E4F9C"),
    "E86": ("Sportin Red & Midnight Black (Taisor/Ebella)", "#B3121B"),
    "E85": ("Enticing Silver & Midnight Black (Taisor/Ebella)", "#C2C5C8"),
    "E5G": ("Cafe White & Midnight Black (Taisor/Ebella)", "#F3F1EA"),
    "FDC": ("Land Breeze Green & Midnight Black", "#5D7A5A"),
}
PEARL_WHITE = {"089", "090"}

MODEL_COLORS = {
    "FRN": ["040", "089", "1D6", "4V8", "4W9", "218", "220", "2PS", "2UE", "2QY"],
    "IMV": ["040", "089", "1D6", "218", "4V8"],
    "INN": ["040", "089", "1D6", "218", "220", "221", "4V8", "2UE", "2PS"],
    "D22": ["ZHJ", "WBE", "WBF", "WBG", "WAJ", "ZAM", "ZQD", "C9J", "ERD", "ESL", "ESY"],
    "D24": ["ZHJ", "WBE", "WBF", "WBG", "Z1Q"],
    "D27": ["ZHJ", "WBE", "WBF", "WBG", "ZYE", "WB3", "E86", "E85", "E5G"],
    "A15": ["ZHJ", "WBE", "ZYA", "Z7Q", "ZQK"],
    "A32": ["ZHJ", "WBE", "WBF", "WBG", "WB3", "E86", "FDC", "E85", "E5G"],
    "CMR": ["089", "218", "1L5", "3U5", "8X8", "1H5", "08B", "1LB", "3UB", "8XB", "1HB"],
    "LCR": ["090", "218"],
    "VEL": ["089", "1L5", "202"],
    "HLX": ["089", "218", "3U5", "1G3", "040"],
}


def paint_of(code):
    if code in PEARL_WHITE:
        return "pearl_white"
    return "dual_tone" if "&" in COLORS[code][0] else "standard"


# Suffixes seen in CTDMS (PO order listings / stock statements) that no price list prints, with the
# CTDMS description, so bookings and stock against them still map to a variant.
EXTRA_VARIANTS = {
    "FRN2L": "Legender 4x4 MT", "FRNB3": "Leader Edition 4x2 MT (old)", "FRNB4": "Leader Edition 4x2 AT (old)",
    "FRNB5": "Leader Edition 4x2 MT", "FRNB6": "Leader Edition 4x2 AT", "FRNCF": "Sigma 4 AT",
    "IMVIM": "GX+ MT 8S (old)", "IMVIN": "GX+ MT 7S (old)", "IMVIP": "GX MT 7S (old)",
    "INNHE": "VX 7S Hybrid (old)", "INNYC": "VX(O) 7S Hybrid",
    "D24ZM": "S MT", "D24ZL": "S AMT", "D24ZN": "E MT", "D24Z4": "S CNG MT",
    "VELE1": "VIP (old)", "VELE3": "VIP (old)", "HLXX4": "High AT", "HLXXA": "4x4 VX AT",
    "A15M1": "S MT CNG", "A32U3": "E3",
}

# ----------------------------------------------------------------------------- price list config

# Numeric columns, left to right, as printed in each list.
PRICE_LISTS = [
    ("HYRYDER PRIVATE NEW", "D22", "private", "2026-07-02",
     "ex tcs rto ins_adv ins_prem ins_33 fastag onroad ew5 tgloss tga smile onroad_smile"),
    ("FORTUNER PRIVATE NEW", "FRN", "private", "2026-10-01",
     "ex tcs rto ins_adv ins_prem ins_33 fastag ew5 tga tgloss onroad smile onroad_smile"),
    ("INNOVA PRIVATE NEW OCT", "IMV", "private", "2026-10-01",
     "ex tcs rto ins_adv ins_prem ins_33 fastag ew5 tgloss tga onroad smile onroad_smile"),
    ("INNOVA COMMERCIAL NEW", "IMV", "commercial", "2026-10-14",
     "ex tcs rto ins_adv ins_prem fastag ew5 tga onroad smile onroad_smile"),
    ("CAMRY PRIVATE", "CMR", "private", "2026-07-02",
     "ex tcs rto ins_adv ins_prem ins_33 fastag tgloss tga ew5 onroad"),
    ("LAND CRUISER NEW", "LCR", "private", "2026-01-06",
     "ex tcs rto ins_prem ins_lux fastag tga tgloss ew5 onroad"),
    ("GLANZA PRIVATE NEW OCT 2026", "D24", "private", "2026-10-23",
     "ex tcs rto ins_adv ins_prem fastag onroad ew5 ess_kit tgloss smile onroad_smile"),
    ("HILUX PRIVATE NEW", "HLX", "private", "2026-07-25",
     "ex tcs rto ins_adv ins_prem ins_33 tga fastag tgloss ew5 onroad smile onroad_smile"),
    ("HYCROSS PRIVATE NEW", "INN", "private", "2026-04-06",
     "ex tcs rto ins_adv ins_prem ins_33 fastag ew5 tgloss tga onroad smile onroad_smile"),
    ("HYCROSS COMMERCIAL NEW", "INN", "commercial", "2026-04-06",
     "ex tcs rto ins_adv ins_prem fastag ew5 tga onroad smile onroad_smile"),
    ("RUMION PRIVATE NEW", "A15", "private", "2026-07-02",
     "ex tcs rto ins_adv ins_prem ins_33 tgloss tga fastag ew5 onroad"),
    ("RUMION COMMERCIAL NEW", "A15", "commercial", "2026-07-01",
     "ex tcs rto ins_adv ins_prem ins_lux tga fastag ew5 onroad"),
    ("TAISOR PRIVATE NEW", "D27", "private", "2026-07-02",
     "ex tcs rto ins_adv ins_prem ins_33 fastag onroad ew5 tgloss ess_kit onroad_kit"),
    ("TAISOR COMMERCIAL NEW", "D27", "commercial", "2026-07-01",
     "ex tcs rto ins_adv ins_prem fastag onroad ew5 ess_kit onroad_kit"),
    ("VELLFIRE NEW", "VEL", "private", "2026-09-06",
     "ex rto tcs fastag ins_adv ins_prem ins_33 ew5 tgloss tga onroad"),
    ("EBELLA PRIVATE NEW", "A32", "private", "2026-06-09",
     "ex tcs rto ins_adv ins_prem fastag onroad ew5 tgloss ess_kit onroad_kit"),
]
INSURANCE_KEYS = {"ins_adv": "advance", "ins_prem": "premium", "ins_33": "premium_3plus3", "ins_lux": "luxury"}
EXTRA_KEYS = ["ew5", "tgloss", "tga", "ess_kit", "smile"]

ACCESSORY_FORMS = [
    # (file stem, model prefix) — of the duplicate Fortuner / Crysta forms, the newest is used.
    ("Glanza Updated Order form", "D24"),
    ("Hyryder Updated Order Form...", "D22"),
    ("Taisor Updated Order Forms", "D27"),
    ("Rumion Order Updated Order Forms", "A15"),
    ("CRYSTA UPDATED ORDER FORM ACC", "IMV"),
    ("Hycross Updated Order Form", "INN"),
    ("fortuner updated order form 09-9-2026", "FRN"),
    ("Camary Updated Order Form", "CMR"),
    ("LC Updated Order Form", "LCR"),
    ("Vellfire Updated Order Form", "VEL"),
]
ACCESSORY_HEADINGS = ["FUNCTIONAL ITEM", "BEAUTIFICATION ITEM", "INTERIOR ACCESSORIES", "EXTERIOR ACCESSORIES",
                      "UTILITY", "HYGIENE", "STYLING", "PROTECTION", "TECHNOLOGY", "COMFORT", "SAFETY"]

EW_MODEL_KEYWORDS = [("crysta", "IMV"), ("fortuner", "FRN"), ("legender", "FRN"), ("glanza", "D24"),
                     ("hyryder", "D22"), ("hycross", "INN"), ("rumion", "A15"), ("taisor", "D27"),
                     ("vellfire", "VEL"), ("lc300", "LCR"), ("camry", "CMR"), ("hilux", "HLX"),
                     ("ebella", "A32")]
EW_PRODUCTS = [("true_warranty_4th_year", 100000), ("true_warranty_5th_year", 100000),
               ("true_warranty_5th_year", 150000), ("true_warranty_5th_year", 200000),
               ("driveline_5th_year", 200000), ("driveline_5th_year", 220000)]


# ----------------------------------------------------------------------------- helpers

def pdf_lines(path):
    out = subprocess.run(["pdftotext", "-layout", path, "-"], capture_output=True, text=True, check=True).stdout
    return out.splitlines()


def num(tok):
    tok = tok.replace(",", "").rstrip("/-")
    return None if tok.startswith("#") else float(tok)


def q(v):
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return str(int(v)) if float(v).is_integer() else repr(v)
    return "'" + str(v).replace("'", "''") + "'"


def infer_fuel(prefix, text):
    t = text.upper()
    if "CNG" in t:
        return "CNG"
    if prefix == "A32":
        return "EV"
    if "HYBRID" in t or "EDRIVE" in t or prefix in ("CMR", "VEL"):
        return "Hybrid"
    if prefix in ("FRN", "IMV", "HLX", "LCR") and "PETROL" not in t:
        return "Diesel"
    return "Petrol"


def infer_transmission(text):
    t = " " + text.upper().replace("(", " ").replace(")", " ").replace("-", " ") + " "
    if "AMT" in t:
        return "AMT"
    if re.search(r"\b(AT|GAT|VAT|AUTOMATIC|EDRIVE|HYBRID|CVT)\b", t):
        return "AT"
    if re.search(r"\b(MT|SMT|GMT|VMT|MANUAL)\b", t):
        return "MT"
    return "AT"


def clean_variant_name(prefix, text):
    t = re.sub(r"\b" + prefix + r"[A-Z0-9]{2}\b", " ", text)
    for s in TWO_CHAR_SUFFIXES.get(prefix, ()):
        t = re.sub(r"(?<![A-Z0-9])" + s + r"(?![A-Z0-9])", " ", t)
    t = re.sub(r"\b(PEARL ?WHITE|PERAL WHITE|PEARLWHITE|PW|DUAL TONE|\bDT\b|PETROL|CNG)\b", " ", t, flags=re.I)
    name = MODELS[prefix][0].upper()
    for w in [name, "URBAN CRUISER", "TOYOTA", "INNOVA CRYSTA", "INNOVA HYCROSS", "HYRYDER NEO DRIVE",
              "HYRYDER HYBRID", "HYRYDER CNG", "HYRYDER NEO", "HYRYDER", "RUMION", "VELLFIRE", "HILUX",
              "FORTUNER", "CAMRY", "EBELLA", "LC", "&", ",", "/"]:
        t = re.sub(re.escape(w), " ", t, flags=re.I)
    t = re.sub(r"\(\s*\)", " ", t)
    return re.sub(r"\s+", " ", t).strip(" -") or "Standard"


# ----------------------------------------------------------------------------- parsers

def parse_price_list(path, prefix, cols):
    cols = cols.split()
    rows, warnings = [], []
    section = ""
    for line in pdf_lines(path):
        toks = line.split()
        tail = []
        while toks and re.fullmatch(r"\d[\d,]*|#REF!", toks[-1]):
            tail.insert(0, toks.pop())
        text = " ".join(toks)
        if len(tail) < 8:
            if text.isupper() and ("TRANSMISSION" in text or "PETROL" in text or "HYBRID" in text or "CNG" in text):
                section = text
            continue
        if prefix in TWO_CHAR_SUFFIXES:
            codes = [prefix + s for s in re.findall(r"(?<![A-Z0-9])([A-Z0-9]{2})(?![A-Z0-9])", text.upper())
                     if s in TWO_CHAR_SUFFIXES[prefix]]
        else:
            codes = re.findall(r"(?<![A-Z0-9])(" + prefix + r"[A-Z0-9]{2})(?![A-Z0-9])", text.upper())
        codes = list(dict.fromkeys(codes))
        if not codes:
            warnings.append(f"no suffix code in row: {line.strip()[:90]}")
            continue
        vals = [num(t) for t in tail]
        if len(vals) == len(cols):
            rec = dict(zip(cols, vals))
        else:
            # A missing cell (e.g. a blank warranty column): align up to on-road from the left and the
            # rest from the right, and say so.
            k = cols.index("onroad") + 1
            rec = dict(zip(cols[:k], vals[:k]))
            rec.update(dict(zip(cols[k:][::-1], vals[k:][::-1])))
            warnings.append(f"{codes[0]}: {len(vals)} values for {len(cols)} columns, aligned around on-road")
        upper = text.upper()
        paint = ("pearl_white" if re.search(r"\bPW\b|PEARL|PERAL", upper)
                 else "dual_tone" if re.search(r"DUAL|\bDT\b", upper) else None)
        rows.append({"codes": codes, "text": text, "section": section, "paint": paint, **rec})
    return rows, warnings


def reconcile(row):
    base = sum(row.get(k) or 0 for k in ("ex", "tcs", "rto", "fastag"))
    extras = [row[k] for k in EXTRA_KEYS if row.get(k)]
    targets = [row[k] for k in ("onroad", "onroad_smile", "onroad_kit") if row.get(k)]
    for ins in [row.get(k) for k in INSURANCE_KEYS if row.get(k)] or [0]:
        for n in range(len(extras) + 1):
            for combo in combinations(extras, n):
                if any(abs(base + ins + sum(combo) - t) <= 2 for t in targets):
                    return True
    return False


def parse_accessories(path):
    items, packages = [], []
    category, tgloss_heading = None, None
    in_tgloss = False
    for line in pdf_lines(path):
        s = line.strip()
        up = s.upper()
        if re.search(r"TGLOSS$", up) and "COATING" not in up:
            in_tgloss = True
        for h in ACCESSORY_HEADINGS:
            if re.search(r"(^|\s)" + h + r"(\s|$)", up):
                category = h.title()
        m = re.match(r"^(\d+)\s+(?:(Hygiene|Styling|Utility)\s+)?(.+?)\s{2,}(\S+)\s{2,}([\d,]+)\s*(?:`\s*)?$", s)
        if m and not in_tgloss:
            sno, cat, name, part, price = m.groups()
            if cat:
                category = cat
            items.append({"sno": int(sno), "category": category, "name": re.sub(r"\s+", " ", name).replace("‐", "-"),
                          "part_no": part, "price": num(price)})
            continue
        if in_tgloss:
            if re.search(r"with \d Boosters?$", s, re.I) and not re.search(r"\d+/-", s):
                tgloss_heading = s
            m = re.match(r"^(.*?)\s{2,}(\d[\d,]*)(?:/-)?\s*$", s)
            if m:
                label, price = m.groups()
                if label.strip().upper().startswith(("TGLOSS", "PREMIUM")):
                    packages.append({"name": re.sub(r"\s+", " ", label).strip(), "price": num(price)})
                elif tgloss_heading:
                    packages.append({"name": f"{tgloss_heading} + Underbody, Silencer, Internal Panel Coating & Rat Repellent (Package)",
                                     "price": num(price)})
    return items, packages


def parse_ew(path):
    groups, cur, names = [], None, []
    for line in pdf_lines(path):
        line = line.rstrip()
        m = re.search(r"(?<![\d-])(\d{1,2}-\d{1,2})\s+((?:[\d,]+\s*){1,6})$", line)
        if m:
            band = m.group(1)
            vals = [num(v) for v in m.group(2).split()]
            if band == "0-2":
                if cur:
                    groups.append((" ".join(names), cur))
                cur, names = [], []
            if cur is not None:
                cur.append((band, vals))
                prefix = line[:m.start()].strip()
                if prefix:
                    names.append(prefix)
            continue
        s = line.strip()
        if cur is not None and s and (not re.search(r"\d", s) or s.upper() == "LC300") and "WARRANTY" not in s.upper() \
                and "Model" not in s and "Unlimited" not in s and "Prices" not in s:
            names.append(s)
    if cur:
        groups.append((" ".join(names), cur))
    out = []
    for name, rows in groups:
        name = re.sub(r"\s+", " ", name).strip()
        prefix = next((p for k, p in EW_MODEL_KEYWORDS if k in name.lower().replace(" ", "")), None)
        for band, vals in rows:
            lo, hi = (int(x) for x in band.split("-"))
            products = [("unlimited_5th_year", None)] if len(vals) == 1 else EW_PRODUCTS
            for (product, km), v in zip(products, vals):
                out.append({"group": name, "prefix": prefix, "lo": lo, "hi": hi, "product": product, "km": km, "price": v})
    return out


# ----------------------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--price-lists", required=True)
    ap.add_argument("--accessories", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    report = []
    variants = {}  # code -> dict(name, fuel, transmission, prefix)
    price_rows = []

    for stem, prefix, list_type, eff, cols in PRICE_LISTS:
        rows, warnings = parse_price_list(os.path.join(args.price_lists, stem + ".pdf"), prefix, cols)
        report += [f"[{stem}] {w}" for w in warnings]
        # Second, dearer row for the same suffix with no paint wording = the model's special paint.
        by_code = defaultdict(list)
        for r in rows:
            by_code[tuple(r["codes"])].append(r)
        for group in by_code.values():
            group.sort(key=lambda r: r["ex"])
            for i, r in enumerate(group):
                if r["paint"] is None:
                    r["paint"] = "standard" if i == 0 else DEFAULT_SPECIAL_PAINT.get(prefix, "pearl_white")
        seen = set()
        for r in rows:
            if not reconcile(r):
                report.append(f"[{stem}] {r['codes'][0]} {r['paint']}: on-road does not reconcile with its components")
            for code in r["codes"]:
                key = (code, r["paint"])
                if key in seen:
                    report.append(f"[{stem}] duplicate {code} {r['paint']} row skipped: {r['text'][:60]}")
                    continue
                seen.add(key)
                desc = r["text"] + " " + r["section"]
                if r["paint"] == "standard" or code not in variants:
                    variants[code] = {"prefix": prefix, "name": clean_variant_name(prefix, r["text"]),
                                      "fuel": infer_fuel(prefix, desc), "transmission": infer_transmission(desc)}
                price_rows.append({**r, "code": code, "list_type": list_type, "eff": eff, "source": stem})
        report.append(f"[{stem}] {len(rows)} rows")

    for code, desc in EXTRA_VARIANTS.items():
        if code not in variants:
            variants[code] = {"prefix": code[:3], "name": desc, "fuel": infer_fuel(code[:3], desc),
                              "transmission": infer_transmission(desc)}

    accessories, vas = [], []
    for stem, prefix in ACCESSORY_FORMS:
        items, packages = parse_accessories(os.path.join(args.accessories, stem + ".pdf"))
        report.append(f"[{stem}] {len(items)} accessories, {len(packages)} TGLOSS items")
        accessories += [{**i, "prefix": prefix} for i in items]
        vas += [{**p, "prefix": prefix} for p in packages]

    ew = parse_ew(os.path.join(args.price_lists, "TSECURE_EW_Customer_Price_List_wef_10_May_2026 WITH GST.pdf"))
    report.append(f"[EW] {len(ew)} prices across {len({e['group'] for e in ew})} model groups")
    for g in sorted({e["group"] for e in ew if not e["prefix"]}):
        report.append(f"[EW] unmapped model group: {g}")

    # ---- SQL
    # Everything is matched on TKM codes (and, the first time, on existing names), never on fixed
    # ids, so the same file updates a database whose catalog was loaded earlier by other means.
    out = ["-- GENERATED by scripts/seed/build_master_seed.py from the dealership's TKM price lists,",
           "-- TGA accessory order forms, the T-Secure EW list and the suffix/colour code sheet.",
           "-- Do not edit by hand; fix the parser/config and regenerate.",
           "-- Rows are matched on TKM model/suffix/colour codes; existing catalog rows (matched by name the",
           "-- first time) are kept and coded rather than duplicated.", ""]

    def values(rows):
        # Rows keyed by a generated id (first column) can repeat when a form lists the same part twice;
        # keep the last occurrence.
        if rows and isinstance(rows[0][0], str) and re.fullmatch(r"[0-9a-f-]{36}", rows[0][0]):
            rows = list({r[0]: r for r in rows}.values())
        return ",\n  ".join("(" + ", ".join(q(v) if not isinstance(v, list) else
                                              "array[" + ", ".join(q(x) for x in v) + "]::text[]" for v in r) + ")" for r in rows)

    model_aliases = {"D22": ["hyryder"], "D27": ["taisor"], "D24": ["toyota glanza"], "A15": ["toyota rumion"],
                     "A32": ["ebella", "toyota urban cruiser ebella"], "CMR": ["camry hybrid", "new camry"],
                     "LCR": ["land cruiser", "lc 300"], "VEL": ["vellfire hybrid"], "IMV": ["innova"]}
    out.append("-- Models")
    out.append("create temp table seed_models (prefix text primary key, name text, segment text, aliases text[], new_id uuid);")
    out.append("insert into seed_models values\n  " + values(
        [[p, m[0], m[1], [m[0].lower()] + model_aliases.get(p, []), uid("model", p)] for p, m in MODELS.items()]) + ";")
    out.append("""update models m set tkm_model_code = s.prefix
from seed_models s
where m.tkm_model_code is null and lower(m.name) = any(s.aliases)
  and not exists (select 1 from models x where x.tkm_model_code = s.prefix);""")
    out.append("""insert into models (id, name, segment, tkm_model_code)
select new_id, name, segment, prefix from seed_models s
where not exists (select 1 from models x where x.tkm_model_code = s.prefix);""")

    color_aliases = {"218": ["attitude black mc", "attitude black mica"], "221": ["blackish ageha gf"],
                     "2PS": ["whitepearl & a.black"], "2UE": ["superwhite & a.black"]}
    out.append("\n-- Colours (an existing colour with the same name gets the code; the most-used one if duplicated)")
    out.append("create temp table seed_colors (code text primary key, name text, hex text, paint text, aliases text[], new_id uuid);")
    out.append("insert into seed_colors values\n  " + values(
        [[c, n, h, paint_of(c), [n.lower()] + color_aliases.get(c, []), uid("color", c)] for c, (n, h) in COLORS.items()]) + ";")
    out.append("""update colors c set tkm_color_code = m.code, paint_category = m.paint, is_dual_tone = (m.paint = 'dual_tone'),
  hex = coalesce(c.hex, m.hex)
from (
  select distinct on (s.code) s.code, s.paint, s.hex, c2.id
  from seed_colors s
  join colors c2 on lower(c2.name) = any(s.aliases) and c2.tkm_color_code is null
  where not exists (select 1 from colors x where x.tkm_color_code = s.code)
  order by s.code, (select count(*) from variant_colors vc where vc.color_id = c2.id) desc, c2.created_at, c2.id
) m
where c.id = m.id and c.tkm_color_code is null;""")
    out.append("""insert into colors (id, name, hex, is_dual_tone, tkm_color_code, paint_category)
select new_id, name, hex, paint = 'dual_tone', code, paint from seed_colors s
where not exists (select 1 from colors x where x.tkm_color_code = s.code);""")

    out.append("\n-- Variants (suffix and tkm_suffix_code both hold the full CTDMS code, e.g. D22U4)")
    out.append("create temp table seed_variants (code text primary key, prefix text, name text, fuel text, transmission text, new_id uuid);")
    out.append("insert into seed_variants values\n  " + values(
        [[code, v["prefix"], f"{MODELS[v['prefix']][0]} {v['name']} ({code[3:]})", v["fuel"], v["transmission"], uid("variant", code)]
         for code, v in sorted(variants.items())]) + ";")
    out.append("""update variants v set tkm_suffix_code = s.code
from seed_variants s
where v.tkm_suffix_code is null and v.suffix = s.code
  and not exists (select 1 from variants x where x.tkm_suffix_code = s.code);""")
    out.append("""insert into variants (id, model_id, fuel_type_id, transmission_id, suffix, name, tkm_suffix_code)
select s.new_id, m.id, f.id, t.id, s.code, s.name, s.code
from seed_variants s
join models m on m.tkm_model_code = s.prefix
join fuel_types f on f.name = s.fuel
join transmissions t on t.name = s.transmission
where not exists (select 1 from variants x where x.tkm_suffix_code = s.code);""")

    out.append("\n-- Variant colours: rebuilt for every seeded variant from the model's TKM colour list,")
    out.append("-- keeping a paint only where the variant's price list prices it (pearl white falls back to standard).")
    paints_by_code = defaultdict(set)
    for r in price_rows:
        paints_by_code[r["code"]].add(r["paint"])
    vc_rows = []
    for code in sorted(variants):
        priced = paints_by_code.get(code)
        for c in MODEL_COLORS[variants[code]["prefix"]]:
            if priced and paint_of(c) == "dual_tone" and "dual_tone" not in priced:
                continue
            vc_rows.append([code, c])
    out.append("create temp table seed_variant_colors (code text, color text);")
    out.append("insert into seed_variant_colors values\n  " + values(vc_rows) + ";")
    out.append("""delete from variant_colors vc
using variants v
where vc.variant_id = v.id and v.tkm_suffix_code in (select code from seed_variants);""")
    out.append("""insert into variant_colors (variant_id, color_id, extra_cost)
select v.id, c.id, 0
from seed_variant_colors s
join variants v on v.tkm_suffix_code = s.code
join colors c on c.tkm_color_code = s.color
on conflict (variant_id, color_id) do nothing;""")

    out.append("\n-- Price list (Rajasthan). Per-colour ex-showroom-only rows for these variants are closed: the")
    out.append("-- engine prefers a colour-specific row, and these lists price by paint category instead.")
    out.append("""update price_list p set effective_to = greatest(p.effective_from, date '2026-10-23')
from variants v
where p.variant_id = v.id and v.tkm_suffix_code in (select code from seed_variants)
  and p.color_id is not null and p.source_file is null and p.effective_to is null;""")
    cols = ["id", "code", "list_type", "paint", "ex", "tcs", "rto", "ins", "fastag", "ew5", "tgloss", "tga", "ess_kit",
            "smile", "onroad", "eff", "source"]
    rows = []
    for r in price_rows:
        ins = {INSURANCE_KEYS[k]: r[k] for k in INSURANCE_KEYS if r.get(k)}
        rows.append([uid("price", r["code"], r["list_type"], r["paint"], r["eff"]), r["code"], r["list_type"], r["paint"],
                     r["ex"], r.get("tcs"), r.get("rto"), "{" + ", ".join(f'"{k}": {q(v)}' for k, v in ins.items()) + "}",
                     r.get("fastag"), r.get("ew5"), r.get("tgloss"), r.get("tga"), r.get("ess_kit"), r.get("smile"),
                     r.get("onroad"), r["eff"], r["source"]])
    out.append("create temp table seed_prices (id uuid, code text, list_type text, paint text, ex numeric, tcs numeric, rto numeric, "
               "ins jsonb, fastag numeric, ew5 numeric, tgloss numeric, tga numeric, ess_kit numeric, smile numeric, onroad numeric, "
               "eff date, source text);")
    out.append("insert into seed_prices values\n  " + values(rows) + ";")
    out.append("""update price_list p set effective_to = s.eff - 1
from seed_prices s join variants v on v.tkm_suffix_code = s.code
where p.variant_id = v.id and p.list_type = s.list_type and p.paint_category = s.paint and p.color_id is null
  and p.state = 'Rajasthan' and p.effective_from < s.eff and p.effective_to is null and p.id <> s.id;""")
    out.append("""insert into price_list (id, variant_id, color_id, state, list_type, paint_category, ex_showroom_price, tcs_amount,
  road_tax_registration, insurance_options, fastag_amount, ew_5th_year_amount, tgloss_package_amount, tga_combo_amount,
  essential_kit_amount, smile_package_amount, on_road_listed, effective_from, source_file)
select s.id, v.id, null, 'Rajasthan', s.list_type, s.paint, s.ex, s.tcs, s.rto, s.ins, s.fastag, s.ew5, s.tgloss, s.tga,
  s.ess_kit, s.smile, s.onroad, s.eff, s.source
from seed_prices s join variants v on v.tkm_suffix_code = s.code
on conflict (id) do update set ex_showroom_price = excluded.ex_showroom_price, tcs_amount = excluded.tcs_amount,
  road_tax_registration = excluded.road_tax_registration, insurance_options = excluded.insurance_options,
  fastag_amount = excluded.fastag_amount, ew_5th_year_amount = excluded.ew_5th_year_amount,
  tgloss_package_amount = excluded.tgloss_package_amount, tga_combo_amount = excluded.tga_combo_amount,
  essential_kit_amount = excluded.essential_kit_amount, smile_package_amount = excluded.smile_package_amount,
  on_road_listed = excluded.on_road_listed;""")

    out.append("\n-- TGA accessories (from the per-model order forms)")
    out.append("create temp table seed_accessories (id uuid, prefix text, name text, part_no text, price numeric, category text, sort_order int);")
    out.append("insert into seed_accessories values\n  " + values(
        [[uid("acc", a["prefix"], a["part_no"], a["name"]), a["prefix"], a["name"], a["part_no"], a["price"], a["category"], a["sno"]]
         for a in accessories]) + ";")
    out.append("""insert into accessories (id, model_id, name, part_no, price, category, is_tga, sort_order)
select s.id, m.id, s.name, s.part_no, s.price, s.category, true, s.sort_order
from seed_accessories s join models m on m.tkm_model_code = s.prefix
on conflict (id) do update set price = excluded.price, category = excluded.category, sort_order = excluded.sort_order, is_active = true;""")

    out.append("\n-- TGLOSS packages and coatings (per model)")
    out.append("create temp table seed_vas (id uuid, prefix text, name text, price numeric);")
    out.append("insert into seed_vas values\n  " + values([[uid("vas", p["prefix"], p["name"]), p["prefix"], p["name"], p["price"]] for p in vas]) + ";")
    out.append("""insert into vas_products (id, name, pricing_type, price, model_id, category)
select s.id, s.name, 'flat', s.price, m.id, 'TGLOSS'
from seed_vas s join models m on m.tkm_model_code = s.prefix
on conflict (id) do update set price = excluded.price, is_active = true;""")

    out.append("\n-- T-Secure extended warranty prices (incl. GST), wef 10 May 2026")
    out.append("create temp table seed_ew (id uuid, model_group text, prefix text, lo int, hi int, product text, km int, price numeric);")
    out.append("insert into seed_ew values\n  " + values(
        [[uid("ew", e["group"], e["lo"], e["product"], e["km"]), e["group"], e["prefix"], e["lo"], e["hi"], e["product"], e["km"], e["price"]]
         for e in ew]) + ";")
    out.append("""insert into ew_prices (id, model_group, model_id, min_age_months, max_age_months, product, km_limit, price, effective_from)
select s.id, s.model_group, m.id, s.lo, s.hi, s.product, s.km, s.price, date '2026-05-10'
from seed_ew s left join models m on m.tkm_model_code = s.prefix
on conflict (id) do update set price = excluded.price;""")

    out.append("\ndrop table seed_models, seed_colors, seed_variants, seed_variant_colors, seed_prices, seed_accessories, seed_vas, seed_ew;")

    with open(args.out, "w") as f:
        f.write("\n".join(out) + "\n")

    print(f"variants={len(variants)} price_rows={len(price_rows)} accessories={len(accessories)} tgloss={len(vas)} ew={len(ew)}")
    print("\n".join(report))
    unmapped = Counter(r["code"][:3] for r in price_rows if r["code"][:3] not in MODELS)
    if unmapped:
        print("UNMAPPED PREFIXES:", unmapped, file=sys.stderr)


if __name__ == "__main__":
    main()
