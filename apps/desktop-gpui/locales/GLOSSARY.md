# Translation glossary

`en.toml` is the source. Every other catalog mirrors its keys and holds plain
strings (or plural forms where English has them). The build rejects a
translation whose placeholders, plural forms or surrounding whitespace differ
from English, and `cargo test -p cap-i18n-build` fails while any key is missing.

## Never translate

- Product and feature names: Cap, Cap Web, Cap Pro, Studio, Instant,
  Studio Sound. Join them the way the language joins words: enregistrements
  Instant, Instant-Aufnahmen, Instant 录制, Instant録画.
- Release channel names: Stable, Nightly. The channel picker still shows them
  in English.
- Quoted values that end up in file names, such as `"studio"`, `"Display"` and
  `"Window"` in the project name help. Only the words around them are
  translated.
- macOS folder names such as `Application Support`.
- Placeholders such as `{version}`, `{names}`, `{origin}`, `{language}`. Move
  them wherever the sentence needs them.
- Window titles. They are not in the catalogs at all: capture exclusion matches
  them by exact title.

## Tone

| Locale | Address | Notes |
| --- | --- | --- |
| fr | vous | Sentence case. Space before `?` and inside `« »`. |
| es | tú | Sentence case. Opening `¿` and `«»` quotes. |
| de | Sie | Sentence case after the first word; nouns capitalized. `„…“` quotes. |
| ja | です/ます in descriptions, plain form in labels | No spaces between Japanese and Latin text. Full-width `（）` and `「」`. |
| zh-CN | 你 | One space between Chinese and Latin letters or digits (`10 秒`, `关于 Cap`). Full-width `（）`, `：` and `“”`. |
| hi | आप | Devanagari with common English loanwords in Devanagari (रिकॉर्डिंग, स्क्रीनशॉट); product names stay in Latin script. |

Menu bar items follow the wording macOS itself uses in each language, so they
sit naturally next to the items AppKit adds.

Keep the English punctuation style of each string: `...` stays three dots and
`…` stays one character, because both appear in the source. Duration units
follow each language (`~45 s`, `~2 Min.`, `約2分`). Mode names in sentences use
the language's word for "mode" around the product name (mode Instant,
Instant-Modus, Instantモード).

Error messages that end in `{error}` show a technical message from the
recording engine, which stays in English.

## Terms

| English | zh-CN | ja | fr | es | de | hi |
| --- | --- | --- | --- | --- | --- | --- |
| recording (noun) | 录制 | 録画 | enregistrement | grabación | Aufnahme | रिकॉर्डिंग |
| record (verb) | 录制 | 録画する | enregistrer | grabar | aufnehmen | रिकॉर्ड करना |
| screenshot | 截图 | スクリーンショット | capture d'écran | captura de pantalla | Bildschirmfoto | स्क्रीनशॉट |
| display | 屏幕 / 显示器 | ディスプレイ | écran | pantalla | Bildschirm | डिस्प्ले |
| window | 窗口 | ウィンドウ | fenêtre | ventana | Fenster | विंडो |
| area | 区域 | 範囲 | zone | área | Bereich | क्षेत्र |
| settings | 设置 | 設定 | paramètres | ajustes | Einstellungen | सेटिंग्स |
| editor | 编辑器 | エディタ | éditeur | editor | Editor | एडिटर |
| upload | 上传 | アップロード | mise en ligne / envoyer | subir | hochladen | अपलोड |
| export | 导出 | 書き出し | exporter | exportar | exportieren | एक्सपोर्ट |
| zoom segment | 缩放片段 | ズームセグメント | segment de zoom | segmento de zoom | Zoom-Segment | ज़ूम सेगमेंट |
| microphone | 麦克风 | マイク | micro | micrófono | Mikrofon | माइक्रोफ़ोन |
| camera | 摄像头 | カメラ | caméra | cámara | Kamera | कैमरा |
| notch | 刘海 | ノッチ | encoche | muesca | Notch | नॉच |
| dock | 程序坞 | Dock | Dock | Dock | Dock | Dock |
| update channel | 更新渠道 | アップデートチャンネル | canal de mise à jour | canal de actualización | Update-Kanal | अपडेट चैनल |
| telemetry | 遥测数据 | テレメトリ | télémétrie | telemetría | Telemetrie | टेलीमेट्री |
| placeholder | 占位符 | プレースホルダ | variable | marcador | Platzhalter | प्लेसहोल्डर |
| excluded windows | 排除的窗口 | 除外するウィンドウ | fenêtres exclues | ventanas excluidas | ausgeschlossene Fenster | बाहर रखी गई विंडो |
| self-host | 自托管 | セルフホスト | auto-hébergement | alojamiento propio | selbst hosten | सेल्फ़-होस्ट |
| System default | 跟随系统 | システムのデフォルト | langue du système | predeterminado del sistema | Systemstandard | सिस्टम डिफ़ॉल्ट |
| Recommended | 推荐 | 推奨 | recommandé | recomendado | empfohlen | सुझाया गया |
| Instant Mode | Instant 模式 | Instantモード | mode Instant | modo Instant | Instant-Modus | Instant मोड |
| Screenshot Mode | 截图模式 | スクリーンショットモード | mode Capture d'écran | modo Captura de pantalla | Bildschirmfoto-Modus | स्क्रीनशॉट मोड |
| System Settings (macOS app) | 系统设置 | システム設定 | Réglages Système | Ajustes del Sistema | Systemeinstellungen | सिस्टम सेटिंग्स |
| Allow (macOS prompt button) | 允许 | 許可 | Autoriser | Permitir | Erlauben | अनुमति दें |
| shareable link | 分享链接 | 共有リンク | lien de partage | enlace para compartir | Link zum Teilen | शेयर करने लायक लिंक |
| clip | 片段 | クリップ | clip | clip | Clip | क्लिप |
| segment (of a recording) | 分段 | セグメント | segment | segmento | Segment | सेगमेंट |
| recover / discard | 恢复 / 丢弃 | 復元 / 破棄 | récupérer / supprimer | recuperar / descartar | wiederherstellen / verwerfen | रिकवर करें / हटाएँ |
| Personal / Commercial plan | 个人版 / 商业版 | 個人 / 商用 | Personnel / Commercial | Personal / Comercial | Privat / Kommerziell | पर्सनल / कमर्शियल |

## Fitting the UI

Keys with `max_px` in `en.toml` sit in fixed-width spots: the settings sidebar,
select buttons, the main window's capture tiles, device rows and status pills,
and the recording controls' stop label. `translations_fit_their_width_budgets`
measures every catalog's text for those keys with the bundled Geist and fails
above 92% of the budget, or above the English width where English is already
wider (the controls' `Resuming…`). Prefer a shorter natural phrase over an
abbreviation when that happens.

## Adding a language

1. Add a `LocaleSpec` to `LOCALES` in `i18n-build/src/lib.rs` with the code,
   an identifier, the endonym and the plural rule.
2. Copy `en.toml` to `<code>.toml`, keep the keys, and translate every value.
   Drop `context`, `max_px` and `size`; a translation is a plain string, or the
   locale's plural forms where English has `one`/`other`.
3. Add a column to the table above and a row to the tone table.
4. If the script needs fonts the system cascade may pick wrongly, add a list to
   `locale_font_fallbacks` in `src/theme.rs`.
5. Map the system tag in `match_tag` (`src/i18n/mod.rs`) if the language
   subtag alone is not enough, as with Chinese scripts.
6. `cargo test -p cap-i18n-build` and the `i18n` tests in the app crate cover
   the rest.
