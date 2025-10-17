# Planning Documentation Index

Complete guide to the multi-recorder CLI planning documentation.

## 📋 Planning Documents (6)

### 1. [README.md](./README.md) - Start Here
**Purpose**: Project overview and quick examples
**Read Time**: 2 minutes
**When to Read**: First time learning about the project

Key topics:
- What multi-recorder does
- Quick examples of all approaches
- Links to other planning docs

---

### 2. [PLAN.md](./PLAN.md) - Main Implementation Plan
**Purpose**: Complete implementation roadmap
**Read Time**: 30 minutes
**When to Read**: Ready to start building

Key topics:
- Architecture and core components
- CLI interface design with routing examples
- Six implementation phases
- Testing strategy and success criteria
- Full Rust code structures

**Sections**:
- Overview & philosophy
- CLI routing syntax
- Config file format (two-phase)
- Implementation phases 1-6
- Validation rules
- Open questions
- Future enhancements

---

### 3. [PLAN-UNIFIED.md](./PLAN-UNIFIED.md) - Unified Approach Details
**Purpose**: Deep dive into CLI + JSON hybrid approach
**Read Time**: 25 minutes
**When to Read**: Implementing CLI parsing and routing

Key topics:
- Three input specification patterns (ID, JSON, @file)
- CLI argument parsing with Rust examples
- Source spec resolution logic
- Config vs CLI mode handling
- Complete implementation code

**Sections**:
- Flexible routing syntax
- JSON schema for all source types
- Full config file format
- Implementation with detailed Rust code
- Validation and error handling
- Help text examples

---

### 4. [PLAN-JSON-CONFIG.md](./PLAN-JSON-CONFIG.md) - Full Config Format
**Purpose**: Complete JSON/YAML config specification
**Read Time**: 20 minutes
**When to Read**: Implementing config file support

Key topics:
- Two-phase declaration (inputs → outputs)
- Complete schema for all input types
- Config validation with detailed error types
- CLI commands for config management
- Advantages of config-first approach

**Sections**:
- JSON structure and YAML alternative
- All input type specifications
- Output specification
- Validation rules and errors
- Example configurations
- CLI integration (generate-config, validate)

---

### 5. [INPUT-PATTERNS.md](./INPUT-PATTERNS.md) - Pattern Comparison
**Purpose**: Compare the three input specification methods
**Read Time**: 10 minutes
**When to Read**: Deciding which pattern to use

Key topics:
- Pattern 1: Simple ID (--display 0)
- Pattern 2: Inline JSON (--display '{"id":0,...}')
- Pattern 3: File Reference (--display @file.json)
- When to use each pattern
- Comparison table and examples

**Sections**:
- Side-by-side comparison
- Characteristics and tradeoffs
- Mixing patterns in one command
- Recommendations and best practices
- Example collection

---

### 6. [QUICK-REFERENCE.md](./QUICK-REFERENCE.md) - Cheat Sheet
**Purpose**: Fast lookup for common patterns
**Read Time**: 5 minutes scan, 2 minutes lookup
**When to Read**: During implementation or testing

Key topics:
- All CLI commands
- Source types table
- Routing patterns
- Common settings
- Recipes for common scenarios
- Troubleshooting

**Sections**:
- Basic commands
- Routing patterns cheat sheet
- Input specification quick reference
- Common settings JSON
- Output formats table
- Recipe collection
- Troubleshooting guide

---

## 🎯 Reading Paths

### For Contributors (Implementing the Tool)

1. **Start**: [README.md](./README.md) - Get overview
2. **Understand**: [PLAN.md](./PLAN.md) - Full architecture
3. **Implement CLI**: [PLAN-UNIFIED.md](./PLAN-UNIFIED.md) - Parsing details
4. **Implement Config**: [PLAN-JSON-CONFIG.md](./PLAN-JSON-CONFIG.md) - Config format
5. **Reference**: [QUICK-REFERENCE.md](./QUICK-REFERENCE.md) - While coding

### For Users (Learning the Tool)

1. **Start**: [README.md](./README.md) - Quick examples
2. **Choose**: [INPUT-PATTERNS.md](./INPUT-PATTERNS.md) - Pick your pattern
3. **Reference**: [QUICK-REFERENCE.md](./QUICK-REFERENCE.md) - Common recipes
4. **Advanced**: [PLAN-JSON-CONFIG.md](./PLAN-JSON-CONFIG.md) - Complex configs

### For Reviewers (Understanding Design)

1. **Overview**: [README.md](./README.md) - What it does
2. **Philosophy**: [PLAN.md](./PLAN.md) - Why this design
3. **Options**: [INPUT-PATTERNS.md](./INPUT-PATTERNS.md) - Tradeoffs
4. **Details**: [PLAN-UNIFIED.md](./PLAN-UNIFIED.md) - How it works

---

## 🔑 Key Concepts

### Declarative Routing
Each source specifies which outputs it feeds:
```bash
--display 0 out1.mp4 out2.mp4 out3.mp4
```

### N→M Flexibility
- 1 source → 1 output: Simple recording
- N sources → 1 output: Combined recording
- 1 source → M outputs: Backup/duplication
- N sources → M outputs: Complex scenarios

### Three Configuration Levels

**Level 1: Simple** (no JSON)
```bash
--display 0 output.mp4
```

**Level 2: Inline** (JSON for settings)
```bash
--display '{"id":0,"settings":{"fps":60}}' output.mp4
```

**Level 3: File Reference** (reusable configs)
```bash
--display @config.json output.mp4
```

**Level 4: Full Config** (complex setups)
```bash
cap-multi-recorder record config.json
```

### OutputPipeline per Output
Each output file = one `OutputPipeline` instance from `cap-recording` crate.

### Shared Sources
Multiple outputs can share the same input source (camera feed, microphone, etc.).

---

## 📊 Document Stats

| Document | Lines | Words | Focus |
|----------|-------|-------|-------|
| README.md | ~100 | ~500 | Overview |
| PLAN.md | ~850 | ~5,000 | Implementation |
| PLAN-UNIFIED.md | ~650 | ~3,500 | CLI Details |
| PLAN-JSON-CONFIG.md | ~700 | ~4,000 | Config Format |
| INPUT-PATTERNS.md | ~350 | ~2,000 | Pattern Guide |
| QUICK-REFERENCE.md | ~300 | ~1,500 | Cheat Sheet |
| **Total** | **~2,950** | **~16,500** | **Complete** |

---

## 🚀 Implementation Status

**Current Phase**: Planning Complete ✅

**Next Steps**:
1. Initialize Cargo project structure
2. Add dependencies (clap, serde, etc.)
3. Implement Phase 1 (Core Infrastructure)
4. See PLAN.md for detailed roadmap

---

## 🤝 Contributing

Before contributing:
1. Read [PLAN.md](./PLAN.md) for architecture
2. Check implementation phases for current status
3. Reference other docs as needed

Questions about design decisions?
- See "Open Questions" in [PLAN.md](./PLAN.md)
- See "Advantages" sections in each plan doc

---

## 📝 Document Relationships

```
README.md (overview)
    ├─→ PLAN.md (main plan)
    │       ├─→ PLAN-UNIFIED.md (CLI details)
    │       └─→ PLAN-JSON-CONFIG.md (config format)
    │
    ├─→ INPUT-PATTERNS.md (pattern guide)
    │       └─→ QUICK-REFERENCE.md (cheat sheet)
    │
    └─→ QUICK-REFERENCE.md (during usage)
```

---

## 🎯 Finding Answers

| Question | Document |
|----------|----------|
| What does this tool do? | [README.md](./README.md) |
| How do I use it? | [QUICK-REFERENCE.md](./QUICK-REFERENCE.md) |
| Simple ID vs JSON? | [INPUT-PATTERNS.md](./INPUT-PATTERNS.md) |
| How to implement CLI parsing? | [PLAN-UNIFIED.md](./PLAN-UNIFIED.md) |
| Config file format? | [PLAN-JSON-CONFIG.md](./PLAN-JSON-CONFIG.md) |
| Implementation phases? | [PLAN.md](./PLAN.md) |
| Architecture decisions? | [PLAN.md](./PLAN.md) |
| Common recipes? | [QUICK-REFERENCE.md](./QUICK-REFERENCE.md) |
| Error handling? | [PLAN-JSON-CONFIG.md](./PLAN-JSON-CONFIG.md) |
| Testing strategy? | [PLAN.md](./PLAN.md) |

---

Last Updated: 2025-01-17
Total Planning Time: ~8 hours
