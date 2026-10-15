; The desktop app starts a bundled pipaya-server.exe next to it. The installer only closes pipaya.exe,
; so a server left running keeps its file locked ("Can't write ...pipaya-server.exe"). Stop it first.
!macro NSIS_HOOK_PREINSTALL
  nsExec::Exec 'taskkill /F /T /IM pipaya-server.exe'
  Pop $0
  Sleep 500
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::Exec 'taskkill /F /T /IM pipaya-server.exe'
  Pop $0
  Sleep 500
!macroend
