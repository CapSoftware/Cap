!macro NSIS_HOOK_PREUNINSTALL
  StrCpy $DeleteAppDataCheckboxState 0
  DetailPrint "Keeping recordings and settings, which Cap Classic shares with Cap."
!macroend
