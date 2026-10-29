; Included automatically by electron-builder (directories.buildResources/installer.nsh).
;
; <install dir>\GenericAgent is the bundled GenericAgent copy the app runs (see
; desktop/src/backend.js bundledGaDir). It holds user data next to GA's code: mykey.py
; (models and keys), memory\, temp\ and sessions. The default uninstaller removes the whole
; install dir, which also runs on every upgrade, so replace it:
;   upgrade   -> remove the app files, keep GenericAgent
;   uninstall -> remove the app files, then ask before deleting GenericAgent (silent: keep)

!macro gahRemoveAppFiles
  Push $R0
  Push $R1
  FindFirst $R0 $R1 "$INSTDIR\*.*"
  gahRemoveLoop:
    StrCmp $R1 "" gahRemoveDone
    StrCmp $R1 "." gahRemoveNext
    StrCmp $R1 ".." gahRemoveNext
    StrCmp $R1 "GenericAgent" gahRemoveNext
    ${if} ${FileExists} "$INSTDIR\$R1\*.*"
      RMDir /r "$INSTDIR\$R1"
    ${else}
      Delete "$INSTDIR\$R1"
    ${endif}
  gahRemoveNext:
    FindNext $R0 $R1
    Goto gahRemoveLoop
  gahRemoveDone:
  FindClose $R0
  Pop $R1
  Pop $R0
!macroend

!macro customRemoveFiles
  !insertmacro gahRemoveAppFiles
  ${ifNot} ${isUpdated}
    ${if} ${FileExists} "$INSTDIR\GenericAgent\*.*"
      MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "是否同时删除内置的 GenericAgent 文件夹？$\r$\n其中包含模型配置（mykey.py）、记忆和会话记录，删除后无法恢复。$\r$\n$\r$\n$INSTDIR\GenericAgent$\r$\n$\r$\nAlso delete the bundled GenericAgent folder? It contains your model configuration (mykey.py), memory and sessions; this cannot be undone." /SD IDNO IDNO gahKeepGa
        RMDir /r "$INSTDIR\GenericAgent"
      gahKeepGa:
    ${endif}
    RMDir "$INSTDIR"
  ${endif}
!macroend
