#!/usr/bin/env python3
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
JM = Path.home() / "tools" / "JM-master" / "source"
FF = Path.home() / "work" / "refsrc"
OUT = ROOT / "src" / "tables.tov"
# Tables wider than their values need: the quantisers are loaded as i32 vectors, and byte loads
# of the zigzag and deblocking tables cost instructions in their hot loops (callgrind).
ELEM = {
    "QUANT4": "i32", "DEQUANT4": "i32", "QUANT8": "i32", "DEQUANT8": "i32",
    "ZIGZAG4": "int", "ZIGZAG8": "int", "DEBLOCK_ALPHA": "int", "DEBLOCK_BETA": "int", "DEBLOCK_TC0": "int",
}


def strip_comments(text: str) -> str:
    text = re.sub(r"/\*.*?\*/", " ", text, flags=re.S)
    return re.sub(r"//[^\n]*", " ", text)


def parse_init(text: str, start: int):
    i = text.index("{", start)
    tokens = re.findall(r"\{|\}|-?\d+|CTX_UNUSED|,", text[i:])
    pos = 0

    def parse():
        nonlocal pos
        assert tokens[pos] == "{"
        pos += 1
        items = []
        while tokens[pos] != "}":
            t = tokens[pos]
            if t == ",":
                pos += 1
                continue
            if t == "{":
                items.append(parse())
            elif t == "CTX_UNUSED":
                items.append([0, 0])
                pos += 1
            else:
                items.append(int(t))
                pos += 1
        pos += 1
        return items

    return parse()


def shape_fill(v, shape):
    if not shape:
        return v if isinstance(v, int) else 0
    out = []
    v = v if isinstance(v, list) else []
    for k in range(shape[0]):
        out.append(shape_fill(v[k] if k < len(v) else 0, shape[1:]))
    return out


def flat(v):
    if isinstance(v, int):
        return [v]
    out = []
    for x in v:
        out += flat(x)
    return out


def table(path: Path, decl: str, shape, after: str | None = None):
    text = strip_comments(path.read_text(errors="replace"))
    start = 0
    if after:
        start = text.index(after)
    m = re.compile(re.escape(decl)).search(text, start)
    if not m:
        raise SystemExit(f"{decl} not found in {path}")
    return flat(shape_fill(parse_init(text, m.end()), shape))


def narrowest(values: list[int]) -> str:
    lo, hi = min(values), max(values)
    for elem, a, b in (("u8", 0, 255), ("i8", -128, 127), ("u16", 0, 65535), ("i16", -32768, 32767)):
        if a <= lo and hi <= b:
            return elem
    return "i32"


def emit(name: str, values: list[int], per_line: int = 32, elem: str | None = None) -> str:
    elem = elem or narrowest(values)
    lines = []
    for i in range(0, len(values), per_line):
        lines.append("  " + ", ".join(str(v) for v in values[i:i + per_line]) + ",")
    return f"export const {name}: {elem}[] = [\n" + "\n".join(lines) + "\n]\n"


def main() -> int:
    vlc = JM / "app" / "lencod" / "vlc.c"
    t = {}
    t["CABAC_INIT_I"] = table(FF / "h264_cabac.c", "cabac_context_init_I[1024][2] =", [1024, 2])
    t["CABAC_INIT_P"] = table(FF / "h264_cabac.c", "cabac_context_init_PB[3][1024][2] =", [3, 1024, 2])
    bia = JM / "app" / "lencod" / "biariencode.c"
    t["CABAC_RANGE_LPS"] = table(bia, "rLPS_table_64x4[64][4]=", [64, 4])
    t["CABAC_NEXT_MPS"] = table(bia, "AC_next_state_MPS_64[64] =", [64])
    t["CABAC_NEXT_LPS"] = table(bia, "AC_next_state_LPS_64[64] =", [64])
    t["COEFF_TOKEN_LEN"] = table(vlc, "lentab[3][4][17] =", [3, 4, 17], "writeSyntaxElement_NumCoeffTrailingOnes(")
    t["COEFF_TOKEN_CODE"] = table(vlc, "codtab[3][4][17] =", [3, 4, 17], "writeSyntaxElement_NumCoeffTrailingOnes(")
    t["COEFF_TOKEN_DC_LEN"] = table(vlc, "lentab[3][4][17] =", [3, 4, 17],
                                    "writeSyntaxElement_NumCoeffTrailingOnesChromaDC(")[:68]
    t["COEFF_TOKEN_DC_CODE"] = table(vlc, "codtab[3][4][17] =", [3, 4, 17],
                                     "writeSyntaxElement_NumCoeffTrailingOnesChromaDC(")[:68]
    t["TOTAL_ZEROS_LEN"] = table(vlc, "lentab[TOTRUN_NUM][16] =", [15, 16], "writeSyntaxElement_TotalZeros(")
    t["TOTAL_ZEROS_CODE"] = table(vlc, "codtab[TOTRUN_NUM][16] =", [15, 16], "writeSyntaxElement_TotalZeros(")
    t["TOTAL_ZEROS_DC_LEN"] = table(vlc, "lentab[3][TOTRUN_NUM][16] =", [3, 15, 16],
                                    "writeSyntaxElement_TotalZerosChromaDC(")[:240]
    t["TOTAL_ZEROS_DC_CODE"] = table(vlc, "codtab[3][TOTRUN_NUM][16] =", [3, 15, 16],
                                     "writeSyntaxElement_TotalZerosChromaDC(")[:240]
    t["RUN_BEFORE_LEN"] = table(vlc, "lentab[TOTRUN_NUM][16] =", [15, 16], "writeSyntaxElement_Run(")
    t["RUN_BEFORE_CODE"] = table(vlc, "codtab[TOTRUN_NUM][16] =", [15, 16], "writeSyntaxElement_Run(")
    lf = JM / "app" / "lencod" / "loop_filter.h"
    t["DEBLOCK_ALPHA"] = table(lf, "ALPHA_TABLE[52]", [52])
    t["DEBLOCK_BETA"] = table(lf, "BETA_TABLE[52]", [52])
    t["DEBLOCK_TC0"] = table(lf, "CLIP_TAB[52][5]", [52, 5])
    t["CHROMA_QP"] = table(JM / "app" / "lencod" / "block.h", "QP_SCALE_CR[52]=", [52])
    scan4 = table(JM / "app" / "lencod" / "block.c", "SNGL_SCAN[16][2] =", [16, 2])
    t["ZIGZAG4"] = [scan4[2 * i] + 4 * scan4[2 * i + 1] for i in range(16)]
    scan8 = table(JM / "app" / "lencod" / "transform8x8.c", "SNGL_SCAN8x8[64][2] =", [64, 2])
    t["ZIGZAG8"] = [scan8[2 * i] + 8 * scan8[2 * i + 1] for i in range(64)]
    qm = JM / "app" / "lencod" / "q_matrix.c"
    t["SIG8_FRAME"] = table(FF / "h264_cabac.c", "significant_coeff_flag_offset_8x8[2][63] =", [2, 63])[:63]
    cab = (FF / "cabac.c").read_text()
    i = cab.index("// last_coeff_flag_offset_8x8")
    t["LAST8"] = [int(x) for x in re.findall(r"\d+", cab[i + len("// last_coeff_flag_offset_8x8"):cab.index("}", i)])][:63]
    ncbp = table(vlc, "NCBP[2][48][2]=", [2, 48, 2])
    t["CBP_CODE_INTRA"] = [ncbp[96 + 2 * i] for i in range(48)]
    t["CBP_CODE_INTER"] = [ncbp[96 + 2 * i + 1] for i in range(48)]
    t["QUANT4"] = table(qm, "quant_coef[NUM_MATRIX_TYPES][4][4] =", [6, 4, 4])
    t["DEQUANT4"] = table(qm, "dequant_coef[NUM_MATRIX_TYPES][4][4] =", [6, 4, 4])
    t["QUANT8"] = table(qm, "quant_coef8[NUM_MATRIX_TYPES][8][8] =", [6, 8, 8])
    t["DEQUANT8"] = table(qm, "dequant_coef8[NUM_MATRIX_TYPES][8][8] =", [6, 8, 8])

    ctx = JM / "lib" / "lcommon" / "ctx_tables.h"
    jm_mb_i = table(ctx, "INIT_MB_TYPE_I[1][3][11][2] =", [1, 3, 11, 2])
    ff_i = t["CABAC_INIT_I"]
    assert jm_mb_i[22:44] == ff_i[0:22], "SI/I mb_type contexts differ between JM and FFmpeg"
    jm_mb_p = table(ctx, "INIT_MB_TYPE_P[3][3][11][2] =", [3, 3, 11, 2])
    ff_p = t["CABAC_INIT_P"]
    for idc in range(3):
        row = jm_mb_p[idc * 66 + 22: idc * 66 + 44]
        base = idc * 2048
        assert row[0:6] == ff_p[base + 2 * 11: base + 2 * 14], f"P mb_skip_flag contexts idc {idc}"
        assert row[8:22] == ff_p[base + 2 * 14: base + 2 * 21], f"P mb_type contexts idc {idc}"
    assert t["ZIGZAG4"] == [0, 1, 4, 8, 5, 2, 3, 6, 9, 12, 13, 10, 7, 11, 14, 15], t["ZIGZAG4"]
    assert t["QUANT4"][:3] == [13107, 8066, 13107] and t["DEQUANT4"][:3] == [10, 13, 10]
    assert t["CABAC_RANGE_LPS"][:4] == [128, 176, 208, 240]
    assert t["CBP_CODE_INTRA"][47] == 0 and t["CBP_CODE_INTER"][0] == 0 and t["CBP_CODE_INTRA"][0] == 3
    assert len(t["LAST8"]) == 63 and t["LAST8"][-1] == 8 and t["SIG8_FRAME"][-1] == 12
    assert len(t["CABAC_INIT_I"]) == 2048 and len(t["CABAC_INIT_P"]) == 6144

    transition = []
    for s in range(128):
        state, mps = s >> 1, s & 1
        for b in range(2):
            if b == mps:
                transition.append(t["CABAC_NEXT_MPS"][state] * 2 + mps)
            else:
                transition.append(t["CABAC_NEXT_LPS"][state] * 2 + (1 - mps if state == 0 else mps))
    t["CABAC_TRANSITION"] = transition
    sig_base = [105, 120, 134, 149, 152, 402]
    last_base = [166, 181, 195, 210, 213, 417]
    sig_ctx, last_ctx = [], []
    for cat in range(6):
        for i in range(64):
            if cat == 3:
                si = li = min(i, 2)
            elif cat == 5:
                si = t["SIG8_FRAME"][i] if i < 63 else 0
                li = t["LAST8"][i] if i < 63 else 0
            else:
                si = li = i
            sig_ctx.append(sig_base[cat] + si)
            last_ctx.append(last_base[cat] + li)
    t["CABAC_SIG_CTX"] = sig_ctx
    t["CABAC_LAST_CTX"] = last_ctx
    t["CABAC_RENORM_SHIFT"] = [6] + [next(s for s in range(9) if ((i << 3) << s) >= 256) for i in range(1, 64)]
    assert t["CABAC_RENORM_SHIFT"][:4] == [6, 5, 4, 4] and t["CABAC_RENORM_SHIFT"][31] == 1
    assert t["CABAC_RENORM_SHIFT"][32] == 0 and t["CABAC_TRANSITION"][0:2] == [2, 1]

    parts = ["// Generated by tools/gen_tables.py from the JM 19 reference software and FFmpeg's h264_cabac.c\n"
             "// (H.264 Tables 8-14..8-17, 9-5, 9-7..9-10, 9-12..9-33, 9-44). Do not edit.\n"]
    for name, vals in t.items():
        parts.append(emit(name, vals, elem=ELEM.get(name)))
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("\n".join(parts))
    print(f"wrote {OUT} ({sum(len(v) for v in t.values())} values)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
