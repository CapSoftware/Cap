; Tauri includes this file right after `SetCompressor /SOLID lzma`, before any
; data is compressed. A 128 MB window lets LZMA match cap-cli.exe against
; Cap.exe, which share most of their code; the default 8 MB window cannot.
SetCompressorDictSize 128

; AI assistants keep `cap mcp serve` running from this install's cap-cli.exe,
; which holds the FFmpeg DLLs open and fails the update with a file-in-use
; error. The server holds no state, so it is ended. Any other cap-cli.exe, such
; as a detached recording worker, is left alone so its recording is never cut
; short. The install directory goes through the environment so no quoting can
; break the command. The caller's $0 is saved and restored around the exit code
; nsExec pushes.
!macro EndCapMcpServers
  Push $0
  System::Call 'kernel32::SetEnvironmentVariable(t "CAP_INSTALL_DIR", t "$INSTDIR")i'
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$cli = Join-Path $$env:CAP_INSTALL_DIR 'cap-cli.exe'; Get-CimInstance Win32_Process | Where-Object { $$_.Name -eq 'cap-cli.exe' -and $$_.ExecutablePath -eq $$cli -and $$_.CommandLine -match '\smcp\s+serve(\s|$$)' } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue; Wait-Process -Id $$_.ProcessId -Timeout 5 -ErrorAction SilentlyContinue }"`
  Pop $0
  Pop $0
!macroend

; Cap 0.6.0 ran its GPUI app as cap-gpui.exe next to Cap.exe. The template
; only closes Cap.exe before copying files, so a running cap-gpui.exe would keep
; the shared FFmpeg DLLs locked and stop the update with a file-in-use error.
!macro NSIS_HOOK_PREINSTALL
  !insertmacro CheckIfAppIsRunning "cap-gpui.exe" "${PRODUCTNAME}"
  !insertmacro EndCapMcpServers
!macroend

!macro NSIS_HOOK_POSTINSTALL
  Delete "$INSTDIR\cap-gpui.exe"
  Delete "$INSTDIR\cap-exporter.exe"
  RMDir /r "$INSTDIR\assets\rive"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro EndCapMcpServers
!macroend
