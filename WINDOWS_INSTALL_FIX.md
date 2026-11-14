# Windows installation repair (ECONNRESET / EPERM)

This project requires npm packages and a separate Electron executable download. An `npm warn deprecated` message does not itself indicate installation failure.

**Root cause in the reported log:** `node_modules\\electron` executes its install script, but the Electron executable download is interrupted with `RequestError: read ECONNRESET`. The `EPERM` cleanup errors typically occur when npm attempts to remove partially installed dependencies that Windows has locked.

## Recommended: one-click recovery

1. Close the failed command window. Quit Electron and close VS Code terminals using this project.
2. Open the unpacked `gemini-project-studio` folder.
3. Double-click **`repair-windows.bat`**.
4. Allow removal of the incomplete `node_modules` folder. **The script will not delete your project source code.**
5. Choose **1** for Electron's official GitHub download source. If GitHub downloads repeatedly fail on your network, rerun the repair script and choose **2** to use `https://npmmirror.com/mirrors/electron/` (independent third-party source; choose it only if you trust it).
6. Once installed, choose to launch the app, or run `start-windows.bat` normally.

If Windows says files are locked, close any processes using the folder or restart Windows before retrying. If `ECONNRESET` persists, try another internet connection or check whether your proxy/firewall blocks GitHub release downloads.

## Manual CMD commands

Run Command Prompt from the project directory (not PowerShell, which uses different environment variable syntax):

```bat
rmdir /s /q node_modules
set "npm_config_fetch_retries=5"
set "npm_config_fetch_retry_mintimeout=20000"
set "npm_config_fetch_retry_maxtimeout=120000"
set "npm_config_fetch_timeout=300000"
npm install --no-audit --no-fund
npm run dev
```

Optional *third-party mirror* after failed official download (set it **before** running `npm install`):

```bat
set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
npm install --no-audit --no-fund
```

This mirror setting only affects the current CMD session. It does not change your global npm registry.

## Official references

- https://www.electronjs.org/docs/latest/faq
- https://www.electronjs.org/docs/latest/tutorial/installation

**Note:** Recovery addresses installation only. Gemini Web browser automation remains experimental and has not been validated against the user's live Gemini session.
