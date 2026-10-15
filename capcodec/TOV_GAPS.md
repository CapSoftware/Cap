# Tov gaps

Features an encoder needs that Tov lacked, what was added on the `encoder-features` branch of Tov, and why. Each feature is general purpose, follows Tov's conventions, and ships with tests and spec updates.

| # | Gap | Status | Commit |
|---|---|---|---|
| 1 | Binary file I/O (`readFileSync` only returned strings) | done | `9cfd397` feat(fs) |
| 2 | `--unchecked` kept bounds checks | done | `bce77c2` feat(unchecked) |
| 3 | Typed arrays (reference semantics, no copy-on-write, shareable) | done | `d4f036f` feat(typed-arrays) |
| 4 | SIMD vector types | done | `d65eb21` feat(simd) |
| 5 | Threads and Atomics | done | `386512e` feat(threads) |
| 6 | C ABI library output (`tov build --lib`) | planned | |
| 7 | WASM target | planned | |
| 8 | Field array stores re-check uniqueness on every store | open | |
| 9 | Module constants initialised by calls see imported constants empty | open | |
| 10 | Typed arrays passed from class fields retain/release atomically per call | done (arguments `976bb78`; element access `02a302a` on branch elem-borrow) | |

## 1. Binary file I/O

**Gap.** `node:fs` had only `readFileSync`/`writeFileSync` on strings. An encoder reads raw YUV frames (3 MB each at 1080p) from files and pipes and writes bitstreams.

**Added.** Node's descriptor API: `openSync`, `closeSync`, `readSync(fd, &buffer, offset?, length?, position?)`, `writeSync(fd, buffer, offset?, length?, position?)`, `fstatSync`. Because Tov arrays are values, `readSync` takes its `u8[]` buffer `inout` (`&buffer`); to support that, standard-library natives can now declare an `inout` array parameter (`native_inout_param`), which code generation passes by pointer after making the buffer unique. Writes to stdout flush `console.log`'s buffer first so output never interleaves. Errors use Node's messages (`EBADF: bad file descriptor, read`), ranges are checked with Node's `RangeError` text.

**Tests.** `tests/run/native_fs_bytes.tov`. **Spec.** §7a.

## 2. `--unchecked` drops bounds checks

**Gap.** `--unchecked` only made integer overflow wrap; every `xs[i]!` and `xs[i] = v` still compared against the length, which blocks vectorisation of pixel loops.

**Added** (commit `bce77c2`): under `--unchecked`, `xs[i]!`, index assignment and compound assignment compile to bare loads/stores (out of bounds is undefined behaviour, as in C); `xs[i]` keeps its defined `T | undefined` result; sized-integer conversions keep the low bits and unary minus and `**` wrap. A 16x16 SAD over a 1080p frame: 0.92 ms instead of 1.5 ms.

**Encoder measurement.** The production presets build with `--unchecked` (see DECISIONS.md); the checked build is kept for the harness's `capcodec-medium-checked` adapter and every unit test.

## 3. Typed arrays

**Gap.** Tov arrays are copy-on-write values, so a buffer held in a class field is made unique on every write, and nothing can be shared between threads or wrapped around memory owned by a C caller.

**Added** (commit `d4f036f`): `Uint8Array`, `Int8Array`, `Uint16Array`, `Int16Array`, `Uint32Array`, `Int32Array`, `Float32Array`, `Float64Array`, `Uint8ClampedArray` with JavaScript semantics (shared references, fixed length, `subarray` views, `set`, `fill`, ...), one compare per element access (none unchecked), atomic reference counts, `readSync`/`writeSync` on `Uint8Array`.

**Follow-up gap (10).** Passing a typed array held in a class field as an argument retains and releases it around every call, atomically. Porting the encoder to typed arrays (branch `typed-arrays-port` in capcodec, bit-identical output) made it 2x slower for this reason alone (transform/quant 1.9 ms → 8.6 ms per 1080p frame), so the encoder stays on `u8[]`/sized-number arrays. Fix to make in Tov: biased reference counting (plain increments until a typed array is shared with another thread) and/or not retaining field reads passed to callees that cannot reassign the field.

## 4. SIMD vector types

**Gap.** Every pixel kernel (SAD, SATD, interpolation, transforms, deblocking) was scalar; clang's auto-vectoriser does not vectorise loops over Tov arrays with 64-bit `int` arithmetic.

**Added** (commit `d65eb21`): `i8x16 u8x16 i16x8 u16x8 i32x4 u32x4 f32x4` and their 256-bit twins as values compiled to the C compiler's vector extensions; `T.load`/`v.store` on typed arrays and sized-number arrays (one bounds check per access, none unchecked), widening loads, lane-wise arithmetic, masks and `select`, `absDiff`, `avg`, `u8x16.sad` (psadbw), `i16x8.madd` (pmaddwd), literal shuffles/swizzles, `widenLow/High`, `packSat`, `bitcast`, `convert`, and `tov build --target-cpu`.

**Encoder use.** SAD, 4x4/8x8 SATD and SA8D, the 6-tap half-pel tiles, quarter-pel averaging, the 4x4 forward and inverse transforms with quantisation, macroblock classification, scroll row hashing, unchanged-macroblock tests, copies and weighted prediction run on vectors; each kernel has a unit test against its scalar definition and the encoder's output stayed byte-identical. Full-motion 1080p (live preset, one core): 10.3 → 21.5 fps across these rounds.

## 8. Field array stores re-check uniqueness on every store

**Gap.** `this.xs[i] = v` on an array held in a class field compiles to `tvg_at_mut(&self->f_xs, ...)`: a copy-on-write uniqueness check (load the buffer pointer, load its refcount) on every store, which the C compiler cannot hoist because the store may alias the refcount. A loop over 8160 macroblocks copying one field array into another (`prevMvx[mb] = mvx[mb]`) took 8% of a whole encode.

**Workaround in the encoder.** Hot loops move into free functions taking the arrays `inout` (one uniqueness check per call), and per-macroblock state was shrunk (one motion vector per macroblock instead of sixteen).

**Fix to make in Tov.** Hoist the uniqueness check and data pointer of a field array out of a loop when the loop body cannot make the array shared (no assignment of the field to another binding, no calls that receive it by value).

## 9. Module constants initialised by calls see imported constants empty

**Gap.** `const T: int[] = build()` at module level, where `build` reads a constant array exported by another module, ran before that module's constants were initialised, and trapped (`index 0 out of bounds for length 0`).

**Workaround in the encoder.** Derived tables (CABAC state transitions, significance context maps, renormalisation shifts, 32-bit quantisation tables) are generated by `tools/gen_tables.py` as literals.

**Fix to make in Tov.** Initialise modules in dependency order (imports first), as JavaScript does.

## 10. Typed-array reference counting on shared data (threads)

**Gap.** With threads, every atomic retain/release of a shared typed array bounces its header's cache line between cores. The encoder's wavefront was slower on 4 threads than on 1 (full_motion 11 vs 15 fps) because field reads passed as arguments (`sad(this.srcY, ...)`), element stores whose value read another field (`this.qpY[mb] = this.mbQp[mb]!`) and element reads whose index read a field (`this.changed[mby * this.mbw + mbx]!`) each took a count.

**Added.** `976bb78` (Tov task): field reads passed to calls are lent without a count when no code the call can run replaces that field. `02a302a` (branch `elem-borrow`, by the encoder author, to be folded in with a test): an element access keeps the array alive only when its index or stored value may replace the field it was read from (Tov's `ta_element` used a syntactic "runs code" test that treated every field read and conversion call as running code). Remaining encoder-side rule: scratch buffers are typed arrays, because a call with an `inout` argument still retains its other typed-array arguments.

**Effect.** 4-thread wavefront: full_motion 1080p 50.8 fps (one thread 25.0), text_scroll 295 (122); byte-identical output.

## 11. Comparing a typed-array element with a sized-integer literal crashes code generation

`ta[i]! === u8(0)` (or `i32(0)`) type-checks but fails in C generation with "internal compiler error: no conversion from `u8` to `int`" (C0003), reported at 1:1 of the entry file. Workaround: compare with an untyped literal (`=== 0`). Fix in Tov: either reject the comparison in the checker with a fix suggestion or convert.

## 12-18. Found while vectorising intra coding (intra-speed branch, all worked around)

12. **`.sum()` widens to 256-bit.** `d.abs().sum()` on an `i16x8` lowers to `__builtin_reduce_add` over eight 32-bit lanes (`vpmovsxwd %xmm,%ymm; vpaddd; vextracti128; ...`, 24 sites). Wanted: lane-width-preserving reductions, pmaddwd-style pair sums for 8/16-bit lanes, horizontal add and movemask primitives. Workaround: accumulate in 16-bit lanes, reduce once per block.
13. **A typed-array local copied from a field takes an atomic count** (`const t = this.c` emits `tv_ta_retain`/`tv_ta_release`), while indexing `this.c[i]!` reloads `self_->f_c->data` and `len` on every access because C is built with `-fno-strict-aliasing`. Wanted: borrow such locals when the field cannot be replaced in their scope (same analysis as gap 10), and keep the data pointer in a register. Workaround: pass arrays as parameters.
14. **`Atomics.wait`/`notify` share one process-global mutex and a linear waiter list**; `notify` locks it even with no waiters. Wanted: per-address (hashed) wait queues and a lock-free no-waiter fast path. Workaround: per-entry waiter counts in capcodec.
15. **The conditional operator lowers to `if`/`else`**, which clang kept as an unpredictable branch in the CABAC LPS select. Wanted: emit `c ? a : b` as a C conditional expression when both arms are pure. Workaround: mask arithmetic.
16. **No combine of two 128-bit vectors into a 256-bit one** (or split): the 16-lane deblock had to store two `i16x8` and reload an `i16x16`, defeating store-to-load forwarding. (Requested with the AVX-512 work: `concat`/`low`/`high`.)
17. **No 64-bit typed arrays or 64-bit vector lanes** (`BigInt64Array`-like `Int64Array`/`Uint64Array`, `i64x2`/`i64x4`): CABAC output uses 32-bit words with backward carry propagation instead.
18. **`parallelFor` hands out chunks of one index** and closures deep-copy captured objects; results come back through `join` or shared typed arrays.

## 19-21. Found while pipelining P frames (thread-efficiency branch, worked around)

19. **`Math.trunc(a / b)` on ints compiles to a float division plus a checked conversion call.** Wanted: an integer division operator or lowering `Math.trunc(int / int)` to C integer division (with the divide-by-zero check). Workaround: multiply-shift helpers for constant divisors.
20. **Every `Atomics` operation is sequentially consistent.** A wavefront progress publish needs only a release store and the wait an acquire load; each macroblock pays a full barrier. Wanted: `Atomics.storeRelease`/`loadAcquire` (or an ordering argument).
21. **Threads can't capture functions or class instances, and a running thread can't receive new typed arrays.** That forces per-frame spawning with a fresh worker `Encoder`, and rules out persistent workers unless reference frames live in a fixed pool of typed arrays. Wanted: a way to pass typed arrays to a running thread (e.g. a channel or a shared slot table) so a pool can live across frames.

## 22-26. Found while reducing peak memory and binary size (footprint branch)

Sizes are x86-64-v3 builds of the footprint branch (unchecked 460,240 bytes, checked 608,256) with Tov 548ff6b; effects of Tov changes were measured by patching the generated C through `CC`, with identical output.

22. **Module integer constants are mutable globals set at start-up.** `const COEF_PER_MB = 416` becomes `static tv_int g7_COEF_PER_MB;`, assigned in `tvg_program`, so every use is a load, products and shifts by it aren't folded and `switch`es on `MB_*` or `CAT_*` can't become jump tables. Emitting the 77 literal-initialised ones as `static const tv_int g7_COEF_PER_MB = INT64_C(416);` (and folding constant expressions such as `BIN_TERM`, `BIG`, `COST_NA`): unchecked -9,568 bytes, checked -6,800, callgrind -1.5% (live busy_ui) to -7.1% (keyint 1 full_motion), -2.7% on medium full_motion. Not worked around: literals in the hot code would replace the names.
23. **Every `try` exit repeats the release of every live local.** `encodeCommand` has 23 error exits, each releasing up to ten strings, arrays and objects (139 release calls, 68 inlined `rl_K*`), an estimated 4-5 KB of its 20.7 KB of own code. Wanted: one cleanup chain per function (labels in reverse declaration order, each exit jumping to the label for its live set) or an outlined cold cleanup.
24. **The global symbol table stays without `-g`.** `-Wl,-x` drops local symbols, but the runtime's `tv_*` globals and their names cost 7,760 bytes; `-Wl,-s` drops them. Worked around in `bench/build_encoder.sh`.
25. **GNU ld pads the segments** (`-z separate-code`): linking with lld saves 10,376 bytes and `-Wl,-z,noseparate-code` with ld.bfd 4,096, code unchanged. Worked around in `bench/build_encoder.sh` (lld when installed). Unwind tables (20.5 KB unchecked, 28.7 KB checked) are already gone without `-g` in Tov 3369524; the script passes the flags until that Tov is installed.
26. **`fill` on a typed array of 16-, 32- or 64-bit elements calls `tv_ta_put_int` per element** (a switch on the element kind each time), where byte arrays get a `memset`. Wanted: a loop per element kind, `memset` for 0.

## 27-32. Found while applying the 548ff6b features (tov-features branch, worked around)

27. **No compile-time query of the target's vector width.** One source serves the x86-64-v3 and v4 builds, so the v4 build cannot select 512-bit kernels (a 32-lane SATD is 10-20% faster on v4 but slower on v3). Wanted: a constant such as `Target.vectorBits` (or `Target.hasAvx512`) usable in `if` so dead branches are removed per build, or per-function multiversioning.
28. **No narrow vector stores.** `v.store` writes every lane; nothing writes 8 bytes (the counterpart of `i16x8.loadU8`), so 8-pixel chroma rows, copies and pads stay scalar. Wanted: `v.storeLow(ta, i)` / `storeN(ta, i, lanes)` and narrowing stores (`i16x8.storeU8`).
29. **Lane lists can't be function parameters** (T0523), so helpers are duplicated per shuffle pattern. Wanted: `const` lane-list parameters (compile-time generic) or inlining-time constant propagation.
30. **Conditional or reassigned typed-array locals still take atomic counts** (`const p = c ? this.a : this.b`), so the 16-way branch in `predictQpel` stays. Wanted: borrow when every arm is a borrowable field path.
31. **Scalar fields are reloaded every iteration in loops that store to typed arrays** because the C is built with `-fno-strict-aliasing`; capcodec hoists `const mbw = this.mbw` by hand. Wanted: hoist loop-invariant scalar field reads when the loop only stores to typed-array elements (which can't alias object fields), or emit `restrict`.
32. **Integer division costs:** `Math.trunc(a / b)` with a constant divisor still adds a ±2^53 range check (about 10 instructions vs 2 for multiply-shift); a variable divisor is a double division; `%` is a checked `idiv`. Wanted: plain C integer division/modulo with only the zero check when both operands are ints.

## 33-40. Found while speeding up keyframes (intra-speed2 branch, worked around)

Measured with callgrind on all-intra encodes (3 frames, 1080p, one thread, matched CRF), as the machine has no hardware counters; every workaround kept the output byte-identical. Tov 538446e (installed during the round) closed two earlier gaps: `Target.vectorBits` / `Target.has` answer 27, and `storeLow` / `storeU8` answer 28 (8- and 4-pixel rows stored with them instead of lane-by-lane stores: 0.04 to 0.23% fewer instructions, commit `5e6ea66`).

33. **No horizontal minimum or argmin.** The I4 mode decision needs the cheapest of nine costs and the first mode reaching it; the scalar loop over the costs took 11.4M instructions on full_motion. Worked around with a swizzle/min ladder, an `eq` against the minimum, `mask()` and `Math.ctz32` (part of `7566916`, -2.1% on full_motion). Wanted: `v.minLanes()` / `maxLanes()` and an index form (`phminposuw` does both for `u16x8` in one instruction).
34. **No shuffle by a runtime index vector** (answered by Tov 538446e's `T.shuffle(table, indices)`, with the branchless `Math.select` requested alongside; not used here yet). The I4 kernel stores every candidate prediction (five 16- or 32-byte stores per 4x4 block, 1.9M instructions on full_motion, 0.27% of the all-intra encode) so the caller can load the chosen mode's by offset; with `pshufb`/`vpermd` by a per-mode index row it would build only the chosen one from the edge vector, so 0.27% is the most it can save.
35. **No multiple return values (tuples are "later").** Kernels with several results write them into a typed-array scratch the caller reloads: the I4 kernel's nine costs plus best mode and cost in an `Int32Array(16)`, the I8 V/H/DC costs, the chroma plane parameters in an `Int16Array(32)` and its edges and DC quads in a 176-byte block. Wanted: returning a record or tuple of ints and vectors, kept in registers when the callee is inlined.
36. **No multiply-high for 16-bit lanes** (`pmulhw` / `pmulhuw` / `pmulhrsw`). capcodec's quantiser adds its rounding offset to the full 32-bit product (`(|c| * q + f) >> qbits`), so the 16-bit path uses `madd` against tables with the odd or even factors zeroed (two `pmaddwd` per 16 coefficients and a recombination) and the rest stays in 32-bit lanes (`vpmulld`). A multiply-high would serve x264's form (`((|c| + bias) * mf) >> 16`), which rounds differently, so it was not measured here.
37. **`mask()` of 16-bit lanes needs a pack first.** `i16x16.eq(...).mask()` lowers to a pack and lane fix-up before `vpmovmskb`; code4's zero test and coefficient count use the byte mask of the same comparison (`u8x32.bitcast`) and halve the popcount (with the `qp % 6` change below, `77e1dc1`: -0.3 to -0.6%). Wanted: `mask()` on 16-bit lanes as `vpmovmskb` plus `pext`, or a `maskBytes()`.
38. **`qp % 6` is a checked signed division** (gap 32's `%`), on every quantiser call: `qp - 6 * qpDiv6(qp)` with the existing multiply-shift `qpDiv6` instead (in `77e1dc1`).
39. **Module-level vector constants are mutable globals.** `const EVEN16 = i16x16(...)` becomes `static tvv_i16x16 g18_EVEN16;` assigned by an initialiser at start-up (as gap 22 for integers), so a `select` against one is an and/andn/or with a memory operand instead of a blend with a constant, and shuffles can't fold it. Wanted: `static const` vector initialisers for literal lanes.
40. **Profiling a split build.** Since programs over 384 KiB of C compile as parallel units, the debug information names temporary C files that are deleted after the build, so `callgrind_annotate` (and `perf annotate`) can't show source lines. `TOV_UNITS=1 tov build -g` restores it (the whole-program build runs 0.4% more instructions than the split one on full_motion). Wanted: keep the unit C files in the cache under stable names in `-g` builds.

## 41-46. Found while profiling main with B-frames and the lookahead (tov-features branch, numbered 33-38 there)

41. **The v4 build can't keep 512-bit types at 256 bits.** Refines 27: lane-wise `i32x16`/`u8x64` code lowers to two ymm operations on x86-64-v3 at the instruction count of two `i32x8`s (16-lane `quant4v`/`dequant4v`/`quant8v`/`dequant8v` and a 32-lane `nonzeroMask`: -0.01% to -0.12% instructions, CPU within noise), so one source can carry wide kernels for v3. On v4 the same code becomes sparse zmm instructions inside ymm code and was slower on this AVX512-FP16 Xeon (interleaved best of 7 and 9: all-intra +2.9% and +5.0%, full_motion medium +1.3% and +2.4%), so it was dropped. Four-row `u8x64` SADs (`sad16` and `sadAvg16`, one `vpsadbw` per four rows) are not neutral on v3 (full_motion medium +0.42%, live +0.12% instructions, from building the two ymm halves out of four 16-byte loads and reducing the wider accumulator) and on v4 CPU, best of 9, cost full_motion medium +4.6% (+11.6% with only `sad16` widened) for full_motion live -0.4% (-2.5%) and text_scroll live within noise, so no v4-only SAD module was kept either. Tov 9d70528 (`Target.vectorBits`) and ce80f99 (`--target-cpu x86-64-v3,x86-64-v4` in one binary) in ~/work/tov answer 27's query but are not in the installed 548ff6b compiler (`Target` is N0001 there). Wanted, next to 27's query: a build option (or per-function attribute) that lowers vectors wider than 256 bits as ymm halves while still using AVX-512VL/BW instructions on ymm (mask compares, `vpternlog`, `vpermt2*`), since clang's `-mprefer-vector-width=256` does not split explicit vector types.
42. **No permute with run-time lane indices.** `shuffle`/`swizzle` take literal lists only, so `pshufb`/`vpermd`/`vpermb` with an index vector (and v4's `vpcompressd`) are unreachable. The CABAC significance-map writer `residualBins` (3.7% of instructions on average, 5.5% on all-intra) could compact four positions' significance and last bins through a 16-entry index table, but stays scalar at about 8 instructions per coefficient position. Wanted: `T.permute(v, idx)` (`pshufb`/`vpermd`), `u8x16.lookup(table, idx)` and `v.compress(mask)`.
43. **No bulk append to a `u8[]` from a typed array.** Copying n bytes is n `push`es, each a `TVG_PUSH_C` with its capacity check: `escapeBytes` pushes the 16 bytes of an escape-free chunk one by one, and `endSlice` used to push every CABAC byte onto the slice header's array before escaping the whole array (removing that copy and escaping the coder's buffer in place: -0.9% to -1.3% instructions on screen content and all-intra). Wanted: `arr.pushFrom(ta, start, n)` (one reserve and a `memcpy`).
44. **Pushes skip their capacity check only for local arrays in loops bounded by a local or a literal.** `reserve_for_pushes` does not apply to `inout` array parameters (the `out` of `escapeBytes`, whose inner loop is `j < 16`) or to loops bounded by a field or `.length`, so those pushes stay `TVG_PUSH_C`/`TVG_PUSH_U`. Wanted: reserve before such loops too, for `inout` targets and loop-invariant field or length bounds.
45. **`subarray` allocates.** `ta.subarray(a, b)` creates a typed-array object (`tv_ta_subarray`), so `dst.set(src.subarray(s, s + 8), d)` is no option for short rows; `copyRect`'s 8- and 4-byte rows are written as all loads then all stores, which clang merges into one 8- or 4-byte load and store (the workaround for 28). Wanted: `dst.setFrom(d, src, s, n)` lowering to `memmove`, or `set(src.subarray(...))` without the allocation.
46. **No way to ask for a branchless select.** `c ? a : b` on ints becomes a C conditional, and whether clang emits `cmov` or a branch depends on the surrounding code: five variants of the CABAC bin loop with the same selects (`range = isLps ? rl : rm`, the renormalisation shift) compiled to between 0 and 2 `cmov`s and 22 to 24 conditional jumps. Wanted: `Math.select(c, a, b)` emitted with `__builtin_unpredictable` (or as mask arithmetic).

## 47-50. Found with Tov 786b6c7 and in the CABAC bin loop (tov-features and tov-features-next branches, numbered 39-42 there)

Instruction counts are callgrind totals of one-thread encodes (full_motion medium 30 frames and live 30, busy_ui and code_editor medium 90, text_scroll live 90, all-intra medium 10); `-g` and stripped builds of one source differ by under 110 instructions.

47. **Field reads outside loops still compile differently from a hand-hoisted local, and nothing pins inlining.** 786b6c7 reads a number field once before a loop when nothing the loop runs can assign it, and removing the encoder's hand hoists, mostly before such loops (`const mbw = this.mbw`), was neutral (-0.05% to +0.12%). The lookahead reads `this.w` and `this.h` in straight-line code instead (`intraOf`, `keepOf`, and `candCost`, which `keepOf` calls up to 11 times per macroblock), where the rule does not apply; removing those hoists too cost full_motion +2.68% (medium) and +3.03% (live) instructions, other content +0.02% to +0.16%, all of it in `Lookahead_push` (+112.6M). `Lookahead_push` inlines `keepOf`, its `candCost` calls and `rowsSad`'s 8-row SAD loop; with the field reads clang made 17 copies of that loop instead of 13, and in four of them loop strength reduction kept sixteen row pointers and spilled them (73-75 instructions with 17-25 stack accesses per 8 rows, instead of 42 with none and the stride in a register). Workaround: the hoists stay in the lookahead. Wanted: the same single read for a field in straight-line code (until something that can assign it runs), so a hand-written local and the field read give the same C, and `@noinline`/`@inline` on functions and methods, so a small kernel such as `rowsSad` is compiled once instead of once per inlined call site.
48. **`Math.idiv` by a variable divisor perturbs the same function.** At the constant divisors (`qp / 6`, the quantiser rounding offsets) `Math.idiv` saves the range check (text_scroll live -0.12%). At the 15 variable-divisor sites (and one by 48) it cost full_motion +2.03% (medium) and +2.23% (live) instructions, other content +0.01% to +0.12%. The lookahead's divisions per macroblock (`mb / this.mbw`, the mean of a short bottom row, `keepOf`'s keep factor) take fewer instructions themselves (the keep factor 3.0M instead of 4.8M), but `Lookahead_push` grew by 85.6M through 39's mechanism (17 SAD loops instead of 13, four of them spilling). Workaround: variable divisors stay `Math.trunc(a / b)`, which 786b6c7 already lowers to the `f64` division because a 64-bit `idiv` has under half `divsd`'s throughput. Wanted: `Math.idiv` by a non-constant divisor lowered the same way when both operands are within ±2^53, so choosing the exact operator costs nothing.
49. **No branch-likelihood hint, so block layout follows how a test is phrased.** In the CABAC bin loop, `if (b >= 0) { decision } else if ...` made clang end the decision block with a `jmp` back to the shared word-flush test; matching plain decisions by `b >= 0 && b < SKIP_TERM`, which clang compiles to one unsigned compare, made the decision the loop's fall-through path, one instruction fewer per decision (all-intra -0.77%, where the new skip-run code never runs). Wanted: `if (Math.likely(c))` (or an `expect` form) emitted as `__builtin_expect`, so the hot path's layout does not depend on the form of its condition. Related to 46.
50. **Scalar shift semantics are undocumented and differ from JavaScript.** `<<`, `>>` and `>>>` on `int` shift 64 bits with the count taken modulo 64 (`1 << 32` is 4294967296, `1 << 64` is 1, and `1 << 41` is 2^41 where JavaScript gives 512); the spec states the modulo rule only for vector lanes. The CABAC table lookup relies on it (`e >> (b & 63)` picks a bin's next state out of one 64-bit table entry; the generated C masks the count again and clang folds both into one `sarx`). Wanted: the rule in the spec's operator section, next to the vector one.

## 51-52. Found in the CABAC range update (tov-features branch, numbered 43-44 there)

Same measurement setup as 47-50; the compiler is the installed Tov with clang 18.1.3.

51. **A change inside one class moves inlining in unrelated encoder functions.** Two versions of the CABAC range update differ only inside `Cabac`: one keeps the LPS renormalisation shifts in spare bits of the existing table, the other in a second `Int64Array` field passed to `encodeBins` as one more parameter. Once closure and temporary names are renumbered, their generated C differs in 48 lines, all of them `Cabac` code: its struct, constructor, drop and print functions, `run`, `encodeBins`, and the field initialisation where the `Encoder` constructor allocates its `Cabac`. Clang nevertheless inlined differently: `diffFrame` (468 instructions) was inlined and `mbDiffers` (733) emitted out of line instead, `ensureTiles` went from 150 to 174 instructions and `computeMvpL` from 211 to 157. Relative to the parent commit, the first version changed full_motion medium by +0.84% instructions, all of it `Cabac_run` (+35.2M), and the second by -0.98% (live +0.99% and -0.98%). Between the two, `Cabac_run` differed by the expected -15.4M, while `ensureTiles` (-23.3M), `computeMvpL` (-4.3M), `codeMbAt` (-3.9M) and `entropyRow` (-3.0M) account for most of the remaining -61M. How the change reaches those functions (presumably through the inliner's cost budgets) was not traced. Consequence: a single change's instruction delta on full_motion carries perturbations of about ±1% that it did not cause, so steps are attributed per function from `-g` profiles. Wanted: as 47, `@noinline`/`@inline`, so the encoder's inlining does not move with unrelated edits.
52. **No branchless select, so an unpredictable select can become a branch.** `range = isLps ? lps << ls : mps << ms` compiles to two `cmov`s. The equivalent `range = (isLps ? lps : mps) << rs`, with `rs = isLps ? ls : ms` and `ls` read from a table, compiles to `test r8d, 0x100; je`, which branches on whether the bin is the LPS (close to random in CABAC) and executes the `ls` load only on that path. This is presumably LLVM's x86 cmov-conversion pass, which turns a `cmov` fed by a load into a branch. Workaround: the first form. Wanted: `Math.select(c, a, b)` that stays branchless, or an unpredictable hint lowered to `__builtin_unpredictable`, so latency-bound loops do not depend on how a select is written. Related to 49.

## 53. Found while shortening the CABAC MPS renormalisation test (tov-features branch, numbered 45 there)

Same setup as 51-52.

53. **No way to keep an expression's association, so a constant can be moved onto the critical path.** In `encodeBins`, `ms = (range - 256 - lps) >>> 63`, next to `mps = range - lps`, is meant to subtract `lps` from `range - 256`, which is ready before the table lookup gives `lps`. Clang instead computes `mps` and derives `ms` from it (`sub r8, rbx; lea rdx, [r8-0x100]; shr rdx, 0x3f`), presumably to share the subtraction. That makes the MPS test three operations after `lps` instead of two, and puts one more cycle on the range chain that limits the bin loop. Reading the `-256` from memory once before the loop keeps the intended order (`add rcx, r12; sub rcx, r9; shr rcx, 0x3f`) at one more instruction per decision (all-intra 2,487,389,509 instead of 2,466,833,084 instructions). Yet that version is faster: interleaved 1-thread medians over 9 reps are busy_ui all-intra 2.224 s against 2.257 s, code_editor all-intra 2.088 s against 2.170 s and all-intra at QP 26 0.714 s against 0.728 s (A/A 1.006, 1.006, 0.991). Neither beat the committed `lps > range - 256 ? 1 : 0` (`cmp` and `setg`), so neither was kept. Wanted: an opaque-value hint (as Rust's `core::hint::black_box`, an empty `asm("" : "+r"(x))` in C) so a latency-bound loop can fix where a constant is applied without loading it from memory.
