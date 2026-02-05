# Editor Renderer Parity Testing

This document describes the parity testing infrastructure that ensures visual consistency between browser and server rendering of the editor compositor.

## Overview

The parity tests verify that the `composeFrame()` function produces identical output across different execution environments (browser Canvas 2D vs server-side `@napi-rs/canvas`). This is critical for guaranteeing that what users see in the editor preview matches what gets exported.

## Test Structure

```
src/__tests__/parity/
├── golden-configs.ts    # Test configurations covering all rendering features
├── render-harness.ts    # Rendering utilities using @napi-rs/canvas
├── compare-images.ts    # Pixel comparison and diff generation
├── parity.test.ts       # Vitest test suite
└── goldens/             # Baseline PNG images (checked into git)
```

## Golden Configurations

The golden configs cover the full scoped rendering surface:

- **Aspect Ratios**: wide, vertical, square, classic, tall, null (source aspect)
- **Padding**: 0%, 20%, 40%
- **Gradient Angles**: 0°, 45°, 90°, 180°, 270°
- **Color Backgrounds**: Various RGB values with alpha=1
- **Mask Types**: rounded and squircle at low/medium/max rounding
- **Shadow Parameters**: Various combinations of spread, blur, and opacity
- **Source Dimensions**: Standard HD, small (320x240), non-standard aspects

## Running Tests

Run the parity tests as part of the normal test suite:

```bash
pnpm --filter @cap/editor-renderer test
```

## Updating Golden Images

When intentional changes are made to the renderer, golden images need to be updated.

### Step 1: Make the rendering change

Edit the renderer code in `packages/editor-renderer/src/`.

### Step 2: Run tests to see failures

```bash
pnpm --filter @cap/editor-renderer test
```

Failing tests will generate `-actual.png` and `-diff.png` files next to the golden images.

### Step 3: Review the differences

Examine the generated diff images to verify the changes are intentional:

```bash
open packages/editor-renderer/src/__tests__/parity/goldens/*-diff.png
```

The diff images highlight changed pixels in red.

### Step 4: Update goldens with explicit flag

Only update goldens after visual verification:

```bash
UPDATE_GOLDENS=true pnpm --filter @cap/editor-renderer test
```

### Step 5: Verify tests pass

```bash
pnpm --filter @cap/editor-renderer test
```

### Step 6: Commit the updated goldens

```bash
git add packages/editor-renderer/src/__tests__/parity/goldens/
git commit -m "chore: update editor-renderer golden images

Reason: <describe the intentional change>
Reviewed: <your name>"
```

## Parity Threshold

The current threshold is set to **0.1%** (0.001) of pixels differing, with a per-pixel tolerance of **2** in any color channel. This threshold accounts for:

- Minor anti-aliasing differences between Canvas implementations
- Floating-point rounding in gradient calculations
- Sub-pixel rendering variations

If a test fails with a diff percentage below 0.1%, review whether the change is acceptable or indicates a regression.

## CI Integration

The parity tests run automatically in CI as part of the `@cap/editor-renderer` test suite. Any changes to:

- `packages/editor-render-spec/`
- `packages/editor-renderer/`

will trigger these tests to gate the change.

## Troubleshooting

### Tests fail with "golden not found"

Run with `UPDATE_GOLDENS=true` to generate initial baselines.

### Tests fail after dependency update

If `@napi-rs/canvas` is updated, minor rendering differences may occur. Review diff images and update goldens if the changes are acceptable.

### Diff images show large differences

Check for:
1. Breaking changes in `composeFrame()` or drawing utilities
2. Changes to `computeRenderSpec()` in `@cap/editor-render-spec`
3. Missing cases in golden configs (add new configs if needed)

## Adding New Golden Configs

When adding new rendering features:

1. Add a new config to `golden-configs.ts`
2. Run tests with `UPDATE_GOLDENS=true`
3. Review the generated golden image
4. Commit both the config change and the new golden image
