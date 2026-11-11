@echo off
rem Lanceur de la CLI dans l'application autonome (Windows).
rem Voir le script "harness" voisin : meme role, meme disposition.
rem MIDGAARD_LAUNCHER est le chemin de ce fichier, entre guillemets : les
rem commandes conseillees par la CLI et le daemon passent par lui.
setlocal
set "MIDGAARD_LAUNCHER="%~f0""
set "MIDGAARD_DASHBOARD_DIR=%~dp0..\dashboard"
"%~dp0..\..\node.exe" "%~dp0..\node_modules\@midgaard\cli\dist\main.js" %*
exit /b %ERRORLEVEL%
