# Uninstall-time cleanup, included automatically by electron-builder because it
# is named installer.nsh and sits in buildResources (see PlatformPackager
# getResource). The macro below is inserted into the uninstall section after the
# "is the app still running" check and before the program files are removed, so
# the SQLite handle is already closed by the time anything here runs.
#
# Why this rather than nsis.deleteAppDataOnUninstall, which is one line:
#
#   1. That option deletes without asking. The directory is the user's entire
#      library -- the database and every stored PDF -- and someone uninstalling
#      to reinstall is a normal thing to do. It asks, and defaults to keeping.
#   2. It deletes more than our directory. The template also runs
#      RMDir /r "$APPDATA\${APP_PACKAGE_NAME}", where APP_PACKAGE_NAME is
#      electron/package.json's "name" -- "desktop". We have never written to
#      %APPDATA%\desktop, and the name is generic enough that another program
#      plausibly owns it. This targets exactly the directory main.mjs writes to.
#
# PRODUCT_FILENAME rather than APP_FILENAME (they are both "Scibrarian" today):
# Electron derives the userData path from the app name, which is productName,
# which is what PRODUCT_FILENAME holds. APP_FILENAME is the installation
# directory name, and only coincidentally the same string.
!macro customUnInstall
  # ${isUpdated} tests the uninstaller's own --updated flag, which the installer
  # passes when it removes an older version in place. An upgrade must never take
  # the library with it, so only a real uninstall reaches the prompt -- and a
  # silent uninstall skips it, keeping the data unless --delete-app-data is
  # passed, which the stock uninstaller handles further down on its own.
  ${ifNot} ${isUpdated}
  ${andIfNot} ${Silent}
    # Electron writes per-user app data even when the app was installed for all
    # users, so this has to read $APPDATA in the current user's context.
    ${if} $installMode == "all"
      SetShellVarContext current
    ${endIf}

    ${if} ${FileExists} "$APPDATA\${PRODUCT_FILENAME}\*.*"
      MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 \
        "Also delete your ${PRODUCT_NAME} library?$\r$\n$\r$\nThis permanently removes the database and every stored PDF in $APPDATA\${PRODUCT_FILENAME}. Choose No to keep them for a future install." \
        /SD IDNO IDNO keepAppData
      RMDir /r "$APPDATA\${PRODUCT_FILENAME}"
      keepAppData:
    ${endIf}

    ${if} $installMode == "all"
      SetShellVarContext all
    ${endIf}
  ${endIf}
!macroend
