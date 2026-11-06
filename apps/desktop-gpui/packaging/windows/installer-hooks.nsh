; Tauri includes this file right after `SetCompressor /SOLID lzma`, before any
; data is compressed. A 128 MB window lets LZMA match cap-cli.exe against
; Cap.exe, which share most of their code; the default 8 MB window cannot.
SetCompressorDictSize 128

; The template only closes Cap.exe before copying files. Anything else running
; from $INSTDIR keeps the shared FFmpeg DLLs loaded and stops the update with a
; file-in-use error: cap-gpui.exe from Cap 0.6.0, and cap-cli.exe, which AI
; assistants keep running as the `cap mcp serve` stdio server. That server holds
; no state, so ending it loses nothing.
!macro NSIS_HOOK_PREINSTALL
  !insertmacro CheckIfAppIsRunning "cap-gpui.exe" "${PRODUCTNAME}"
  !insertmacro CheckIfAppIsRunning "cap-cli.exe" "${PRODUCTNAME}"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  Delete "$INSTDIR\cap-gpui.exe"
  Delete "$INSTDIR\cap-exporter.exe"
  RMDir /r "$INSTDIR\assets\rive"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro CheckIfAppIsRunning "cap-cli.exe" "${PRODUCTNAME}"
!macroend
