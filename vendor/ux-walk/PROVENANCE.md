# Walk engine provenance

This directory is Worm's walk engine: the transcription, timeline, brief, ledger, project and tracker code that processes the walks Worm records, plus the `ux-walk` CLI that agents use to read and file a walk's items.

It began as a copy of [UX Walk](https://github.com/CantrellJax/ux-walk) at revision `82b51646cacd5e316c7a57ab6e7f620127e85076`. UX Walk is retired and archived; Worm replaces it, and this directory is now maintained here as ordinary Worm source. Edit it directly. There is no upstream to sync from.

UX Walk's standalone recorder (the `record`, `call` and `video` commands, the menu bar app, the `uxw-capture` window recorder, the Meet companion and its agent skill) was removed when the engine moved here, because Worm records walks itself.

The engine is licensed under the GNU Affero General Public License, version 3 only (`AGPL-3.0-only`); see [LICENSE](LICENSE). The bundled app carries this file and that license in `Contents/Resources/ux-walk`.
