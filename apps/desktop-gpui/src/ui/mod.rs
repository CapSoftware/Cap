//! The shared component library.
//!
//! Every window in this app was hand-rolling its own buttons, toggles, selects,
//! sliders and cards. The Tauri app does not: `packages/ui-solid/src/Button.tsx`,
//! `components/Toggle.tsx` and `routes/editor/ui.tsx` are imported by the
//! editor, the settings pages, the teleprompter, the main window and the
//! screenshot editor alike. This module is that set, transcribed once.
//!
//! ## How a component is themed
//!
//! `theme.css` re-skins controls per window through attribute selectors --
//! `[data-macos-native-material="settings"] .cap-toggle { background:
//! var(--macos-settings-control-fill) }` and friends. There is no general
//! mechanism here to match it, because the remaps are not general: only three
//! surfaces exist in the shipping CSS and each one re-points a specific,
//! enumerable list of properties. So every component carries **named
//! constructors, one per surface**, and the quoted CSS rule lives in the
//! constructor:
//!
//! | constructor | window | token set |
//! |---|---|---|
//! | `::body(theme, ..)` | main window | Radix, with `Theme::body_*`'s panel-material remaps |
//! | `::settings(theme, ..)` | settings | `--macos-settings-*` (`Theme::settings_*`) |
//! | `::glass(theme, ..)` | teleprompter | bare glass: `gray-12` at 5/7/8/10 % |
//! | `::plain(theme, ..)` | editor, mode select | Radix, no material |
//!
//! A call site that needs a colour no surface provides sets it explicitly --
//! the builders all expose the individual colours -- so consolidation never
//! costs fidelity.
//!
//! ## Event handlers
//!
//! Handlers are `impl Fn(&ClickEvent, &mut Window, &mut App)`, which is exactly
//! what `cx.listener(..)` produces for any window type. Components are
//! therefore window-agnostic without a generic parameter.

// The library is transcribed whole rather than trimmed to today's callers,
// for the same reason `Theme` carries the Radix steps nothing paints yet:
// half a variant scale is worse than none, because the next person needing
// `destructive` would have to go back to `Button.tsx` and re-derive it.
#![allow(dead_code)]

mod button;
mod collapsible;
mod editor_button;
mod field;
mod kbd;
mod number_field;
mod radio_cards;
mod menu;
mod progress;
mod segmented;
mod select;
mod slider;
mod surface;
mod tab_rail;
mod text_input;
mod toggle;
mod tooltip;

// Some of these have no call site in this rev. They are the foundation tier
// the editor's sidebar unit was blocked on -- `KbdChip` for `EditorButton`'s
// `kbd` prop, `Tooltip` for its `tooltipText`/`comingSoon` arms,
// `CircularProgress` for the export flow's three hand-rolled rings -- and
// building them with the rest is the point of the unit. They are covered by
// their own tests rather than by a caller.
#[allow(unused_imports)]
pub use button::{Button, ButtonSize, ButtonVariant, ClickHandler, IconButton};
#[allow(unused_imports)]
pub use collapsible::{Collapsible, CollapsibleState};
#[allow(unused_imports)]
pub use editor_button::{EditorButton, EditorButtonVariant};
#[allow(unused_imports)]
pub use field::{Field, Subfield};
#[allow(unused_imports)]
pub use kbd::{KbdChip, KbdSize, kbd_symbol};
#[allow(unused_imports)]
pub use number_field::{
    NumberChange, NumberField, NumberFieldState, NumberLimits, format_number, parse_number,
};
#[allow(unused_imports)]
pub use radio_cards::{RadioCard, RadioCards};
#[allow(unused_imports)]
pub use menu::{Menu, MenuItem, MenuKey, MenuState};
#[allow(unused_imports)]
pub use progress::CircularProgress;
#[allow(unused_imports)]
pub use segmented::{SegmentOption, SegmentedControl, option_at};
#[allow(unused_imports)]
pub use select::Select;
#[allow(unused_imports)]
pub use slider::{
    Slider, SliderDrag, SliderTrack, fraction_from_x, snap_to_step, value_at as slider_value_at,
    value_from_fraction,
};
#[allow(unused_imports)]
pub use surface::{Card, Popover, SettingRow, Section};
#[allow(unused_imports)]
pub use tab_rail::{TabRail, TabRailItem};
#[allow(unused_imports)]
pub use text_input::{
    TextInput, TextInputEvent, TextInputState, bind_keys as bind_text_input_keys,
    text_input_has_focus,
};
#[allow(unused_imports)]
pub use toggle::{Toggle, ToggleSize};
#[allow(unused_imports)]
pub use tooltip::{Tooltip, TooltipStyle};
