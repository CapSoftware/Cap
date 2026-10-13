; Tauri includes this file right after `SetCompressor /SOLID lzma`, before any
; data is compressed. A 128 MB window lets LZMA match cap-cli.exe against
; Cap.exe, which share most of their code; the default 8 MB window cannot.
SetCompressorDictSize 128

!macro NSIS_HOOK_POSTINSTALL
  Delete "$INSTDIR\cap-gpui.exe"
  Delete "$INSTDIR\cap-exporter.exe"
  RMDir /r "$INSTDIR\assets\rive"
!macroend
