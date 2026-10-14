# CSS

The target design system for Cap's GPUI desktop app (`apps/desktop-gpui`) only. The **Theme CSS**
block below is an exact copy of `platform.css`, formatted by Biome. This is the supplied palette,
not an extension of the web or Tauri styles. Read these rules before desktop UI work.

`platform.css` is not loaded by GPUI yet. The existing Rust theme still uses its older palette and
hardcoded styling; adding these files alone does not change the app's appearance. The Rust token
mapping, component migration and enforcement are subsequent work.

## Rules

- **For new and migrated UI, use these tokens, not literal colors, alpha tints, radii or shadows.**
  Resolve CSS `var(...)` and `color-mix(...)` definitions when mapping them into Rust; do not
  substitute new shades. Never derive a UI state by mixing colors or changing alpha at a call site.
- **Do not invent more CSS, token names or component-specific palettes.** If the supplied theme
  does not cover a required UI state, surface the gap for a design decision before changing the
  theme. Keep `platform.css` and the Theme CSS block here identical in the same change.
- Use semantic names in the eventual Rust theme mapping: CSS `--surface-raised` corresponds to
  `surface_raised`. Select by role, not by a visually similar hex value.
- Light values are in `:root`, dark values in `.dark`. Resolve the chosen set using Cap's existing
  appearance preference and system appearance handling. Radii and shadows are shared.
- Use tokens for what they name:
  - **Surfaces:** `surface` for the window and panel base, `surface-secondary` / `surface-subtle` for
    recessed areas, `surface-raised` for cards and raised controls, `surface-inverse` for inverted
    chips. `surface-overlay` is the modal dialog scrim and nothing else.
  - **Borders:** `border` by default, `border-subtle` / `border-softer` for dividers inside a surface,
    `border-strong` for outlines that must stand out, `border-inverse` on `surface-inverse`.
  - **Text:** `text-primary` for headings and key values, `text-default` for body text,
    `text-secondary` for supporting text, `text-muted` for placeholders and disabled text.
    `text-positive` / `text-negative` / `text-danger` / `text-warning` for status text only.
  - **Interactive text and icons:** `text-interactive` with `icon` at rest; `text-hover` /
    `text-active` with `icon-active` on hover, press or selection. Keep text and icon in step, as the
    CSS comment requires; never point one token at the other.
  - **Interaction fills:** `hover-bg` for hover and selected rows, `active-bg` for the pressed fill,
    `disabled-bg` for disabled fills.
  - **Status:** `positive`, `negative`, `warning`, `indigo`, `purple`, each paired with its `-subtle`
    fill for badges and banners when that status is relevant.
  - **Primary action:** `primary` fill with `primary-foreground` text, `primary-hover` /
    `primary-active` for hover and press, `primary-disabled` + `primary-disabled-foreground` when
    disabled, `primary-subtle` for a selected tint.
  - **Destructive action:** `danger` fill with `danger-foreground` text, `danger-hover` on hover,
    `danger-disabled` + `danger-disabled-foreground` when disabled, `danger-ring` for an invalid
    field's error ring. Use destructive colors for actions such as delete; recording state needs
    a separate review rather than assuming a trading-style negative status.
  - **Neutral button:** `button-fill` with `button-fill-foreground`, `button-fill-hover` /
    `button-fill-active` for hover and press, `button-fill-subtle` for its quiet variant.
- **Focus:** use `ring-primary` for the focus indicator; do not improvise a new focus color.
- **Radii** come from the five radius tokens only: `radius-small` (4), `radius-compact` (6),
  `radius-default` (8), `radius-medium` (12) and `radius-large` (999, pills and circles).
- **Shadows** come from `shadow-1`, `shadow-2`, `shadow-3` or `shadow-dialog` (dialogs only).
- **Motion:** the CSS specifies a 240ms ease-in-out background transition for
  `button.bg-primary`, disabled by reduced-motion preference. That CSS selector does not apply
  to GPUI; only implement the matching behavior if GPUI supports it and can respect reduced motion.
- **User content is not UI.** Colors the user picks or that come from media (wallpapers, gradient
  and color presets, annotation colors, the color picker's swatches, camera and video frames) are
  data, not theme tokens. The controls around them still use tokens.

## Not defined by this theme

These have no supplied token. Preserve existing behavior until the missing rules are decided;
do not silently make up values or claim the strict-token migration is complete.

- Border width.
- Typography: font family, sizes, weights and line heights.
- Spacing and control sizes.
- Window materials (macOS glass, Windows Mica or Acrylic).
- Any transition other than the primary button's.

## Components

Put shared controls in `src/ui`; the component owns its colors, border, radius, shadow and
interaction states. Callers choose the existing component variant by meaning and supply layout,
not per-window paint overrides. Migrate the existing `plain`, `body`, `settings` and `glass`
styles deliberately; they are not tokenized yet. Do not copy Aeris's trading-specific variants.

Map neutral filled buttons to `button-fill` / `button-fill-hover` / `button-fill-active` /
`button-fill-foreground`, brand actions to the `primary-*` set, destructive actions to
`danger-*`, and quiet controls to the surface, border, text and interaction tokens. Keep the
matching disabled foreground with each disabled fill. Audit Cap's existing `ButtonVariant`
names before changing their meanings: its current `Primary` is neutral and `Blue` is the brand
action. Use `surface-overlay` only when a modal actually has a dimming scrim, and
`shadow-dialog` for dialogs.

## Changing a value

Change `platform.css` and the Theme CSS block below together, in the same commit. The two must stay
identical. Format the CSS with `bun run biome check --write apps/desktop-gpui/platform.css`,
then copy the formatted result here.

## Theme CSS

```css
:root {
	/* Surfaces */
	--surface: #ffffff;
	--surface-secondary: #fafafa;
	--surface-subtle: #fafafa;
	--surface-raised: #f0f0f0;
	--surface-overlay: color-mix(in srgb, #000000 50%, transparent);
	--surface-inverse: #222222;

	/* Borders */
	--border: #e5e5e5;
	--border-secondary: var(--border);
	--border-subtle: #f0f0f0;
	--border-softer: #f5f5f5;
	--border-strong: #c2c2c2;
	--border-inverse: #222222;

	/* Text */
	--text-primary: #222222;
	--text-default: #404040;
	--text-secondary: #646465;
	--text-muted: #c2c2c2;
	--text-positive: var(--positive);
	--text-negative: var(--negative);
	--text-danger: var(--danger);
	--text-warning: #ff6900;
	/* Text on interactive items (buttons, tabs, links). Keep these values in
     step with --icon / --icon-active: normal text = normal icon colour,
     hover/active text = active icon colour. They are separate tokens on
     purpose, never point one at the other. */
	--text-interactive: #646465;
	--text-hover: #404040;
	--text-active: #404040;

	/* Interaction states — hover / selected fill, pressed fill, disabled fill. */
	--hover-bg: #f0f0f0;
	--active-bg: #e5e5e5;
	--disabled-bg: #e5e5e5;

	/* Icons — normal and hovered/pressed/selected */
	--icon: #646465;
	--icon-active: #404040;

	/* Status — gains / losses, success / failure. Shared with the main platform. */
	--positive: #089981;
	--positive-subtle: #dcf5f0;
	--negative: #f7525f;
	--negative-subtle: #ffe2e2;
	--warning: #ff6900;
	--warning-subtle: #ffedd4;
	--indigo: #615fff;
	--indigo-subtle: #e0e7ff;
	--purple: #ad46ff;
	--purple-subtle: #f3e8ff;

	/* Actions */
	--primary: #0182fb;
	--primary-hover: color-mix(in srgb, var(--primary) 90%, transparent);
	--primary-active: #006bd6;
	--primary-disabled: color-mix(in srgb, var(--primary) 30%, var(--surface));
	--primary-disabled-foreground: color-mix(
		in srgb,
		var(--primary) 65%,
		var(--surface)
	);
	--primary-subtle: color-mix(in srgb, var(--primary) 12%, var(--surface));
	--primary-foreground: #f5f5f5;
	--danger: #f7525f;
	--danger-hover: #e5404d;
	--danger-disabled: #ffc9c9;
	--danger-disabled-foreground: #ffa2a2;
	--danger-ring: #ffc9c9;
	--danger-foreground: #ffffff;

	/* Buttons — neutral default button */
	--button-fill: #333333;
	--button-fill-hover: #404040;
	--button-fill-active: #222222;
	--button-fill-foreground: #ffffff;
	--button-fill-subtle: #f5f5f5;

	/* Focus */
	--ring-primary: var(--primary);

	/* Radius */
	--radius-default: 8px;
	--radius-medium: 12px;
	--radius-small: 4px;
	--radius-large: 999px;
	--radius-compact: 6px;

	/* Shadows */
	--shadow-1:
		0 0 1px 0 color-mix(in srgb, #000000 20%, transparent),
		0 1px 2px 0 color-mix(in srgb, #000000 5%, transparent),
		0 1px 1px 0 color-mix(in srgb, #000000 1%, transparent);
	--shadow-2: 0 1px 6px 0 color-mix(in srgb, #000000 10%, transparent);
	--shadow-3: 0 2.75px 5.5px 0 color-mix(in srgb, #000000 10%, transparent);
	--shadow-dialog:
		0 4px 6px -4px color-mix(in srgb, #101828 10%, transparent),
		0 10px 15px -3px color-mix(in srgb, #000000 10%, transparent);
}

.dark {
	/* Surfaces */
	--surface: #1f1f1f;
	--surface-secondary: #222222;
	--surface-subtle: #2b2b2b;
	--surface-raised: #333333;
	--surface-overlay: color-mix(in srgb, #000000 60%, transparent);
	--surface-inverse: #ffffff;

	/* Borders */
	--border: #333333;
	--border-secondary: var(--border);
	--border-subtle: #333333;
	--border-softer: #2b2b2b;
	--border-strong: #404040;
	--border-inverse: #ffffff;

	/* Text */
	--text-primary: #f5f5f5;
	--text-default: #f0f0f0;
	--text-secondary: #c2c2c2;
	--text-muted: #808080;
	--text-positive: var(--positive);
	--text-negative: var(--negative);
	--text-danger: #ffa2a2;
	--text-warning: #ffb86a;
	--text-interactive: #c2c2c2;
	--text-hover: #f0f0f0;
	--text-active: #f0f0f0;

	/* Interaction states */
	--hover-bg: #333333;
	--active-bg: #404040;
	--disabled-bg: #404040;

	/* Icons */
	--icon: #c2c2c2;
	--icon-active: #f0f0f0;

	/* Status — gains / losses, success / failure. Shared with the main platform. */
	--positive: #089981;
	--positive-subtle: #193c37;
	--negative: #f7525f;
	--negative-subtle: #532b2e;
	--warning: #ff6900;
	--warning-subtle: #7e2a0c;
	--indigo: #615fff;
	--indigo-subtle: #312c85;
	--purple: #ad46ff;
	--purple-subtle: #59168b;

	/* Actions */
	--primary: #0182fb;
	--primary-hover: color-mix(in srgb, var(--primary) 90%, transparent);
	--primary-active: #006bd6;
	--primary-disabled: color-mix(in srgb, var(--primary) 35%, var(--surface));
	--primary-disabled-foreground: color-mix(in srgb, var(--primary) 65%, white);
	--primary-subtle: color-mix(in srgb, var(--primary) 22%, var(--surface));
	--primary-foreground: #f5f5f5;
	--danger: #f7525f;
	--danger-hover: #f96a75;
	--danger-disabled: #6b3135;
	--danger-disabled-foreground: #d0646c;
	--danger-ring: #c10007;
	--danger-foreground: #ffffff;

	/* Buttons — neutral default button */
	--button-fill: #f5f5f5;
	--button-fill-hover: #e0e0e0;
	--button-fill-active: #d4d4d4;
	--button-fill-foreground: #404040;
	--button-fill-subtle: #222222;

	/* Focus */
	--ring-primary: var(--primary);
}
button.bg-primary {
	transition: background-color 240ms ease-in-out;
}
@media (prefers-reduced-motion: reduce) {
	button.bg-primary {
		transition: none;
	}
}
```
