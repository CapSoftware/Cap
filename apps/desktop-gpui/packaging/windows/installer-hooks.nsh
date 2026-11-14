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

; Any other cap-cli.exe or cap-muxer.exe running from this install holds the
; FFmpeg DLLs open. Copying over them failed with an Abort, Retry, Ignore
; prompt after Cap.exe was already replaced, so Abort or Ignore left a mix of
; versions on disk (and a silent install skipped the files). Nothing is copied
; until they have exited: the check waits up to 10 seconds, then asks the user
; to stop them, and a silent install or Cancel stops before any file changes.
; Starting PowerShell costs seconds, so it only runs when a process with either
; name exists. Exit code 2 means one from this install is still running; any
; other failure of the check keeps the previous behaviour of going ahead.
!macro WaitForCapCommandLineTools ABORT_TEXT
  !define CapToolsCheck cap_tools_check_${__LINE__}
  Push $0
  Push $1
  System::Call 'kernel32::SetEnvironmentVariable(t "CAP_INSTALL_DIR", t "$INSTDIR")i'
  ${CapToolsCheck}:
  nsis_tauri_utils::FindProcessCurrentUser "cap-cli.exe"
  Pop $0
  ${If} $0 != 0
    nsis_tauri_utils::FindProcessCurrentUser "cap-muxer.exe"
    Pop $0
  ${EndIf}
  ${If} $0 = 0
    nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "try { $$dir = [IO.Path]::GetFullPath($$env:CAP_INSTALL_DIR).TrimEnd('\'); $$deadline = (Get-Date).AddSeconds(10); do { $$running = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { ($$_.Name -eq 'cap-cli.exe' -or $$_.Name -eq 'cap-muxer.exe') -and $$_.ExecutablePath -and ([IO.Path]::GetDirectoryName($$_.ExecutablePath) -eq $$dir) }); if ($$running.Count -eq 0) { exit 0 }; Start-Sleep -Milliseconds 500 } while ((Get-Date) -lt $$deadline); exit 2 } catch { exit 0 }"`
    Pop $0
    Pop $1
    ${If} $0 == 2
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Cap's command line tool is still running, for example a recording started with cap record or an export. Stop it, then click Retry." /SD IDCANCEL IDRETRY ${CapToolsCheck}
      Abort "${ABORT_TEXT}"
    ${EndIf}
  ${EndIf}
  Pop $1
  Pop $0
  !undef CapToolsCheck
!macroend

; Cap 0.6.0 ran its GPUI app as cap-gpui.exe next to Cap.exe. The template
; only closes Cap.exe before copying files, so a running cap-gpui.exe would keep
; the shared FFmpeg DLLs locked and stop the update with a file-in-use error.
!macro NSIS_HOOK_PREINSTALL
  !insertmacro CheckIfAppIsRunning "cap-gpui.exe" "${PRODUCTNAME}"
  !insertmacro EndCapMcpServers
  !insertmacro WaitForCapCommandLineTools "Cap was not updated because its command line tool is still running."
!macroend

!macro NSIS_HOOK_POSTINSTALL
  Delete "$INSTDIR\cap-gpui.exe"
  Delete "$INSTDIR\cap-exporter.exe"
  RMDir /r "$INSTDIR\assets\rive"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro EndCapMcpServers
  !insertmacro WaitForCapCommandLineTools "Cap was not uninstalled because its command line tool is still running."
!macroend
