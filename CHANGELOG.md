# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.22-bradmisfit.6] - 2026-10-01

### Fixed

- **Remote Workspace no longer gets stuck "offline".** The Desktop client now
  sends a heartbeat every 15 seconds and treats a link that has gone silent for
  45 seconds as lost, closing it and reconnecting automatically. Previously, if
  the Work Agent relay dropped the session without a close frame, Desktop kept
  believing it was connected and never reconnected until you did it by hand.
- **Reconnects back off sensibly** (1s, 2s, 4s… up to 15s) instead of retrying
  every second forever.
- **Startup retries.** If the relay is unreachable when Desktop starts (for
  example while the Work Agent runtime is being updated), it keeps retrying in
  the background instead of staying offline.

## [0.0.22-bradmisfit.5] - 2026-09-04

### Added

- **Download to device works properly.** Prepared Video Workspace downloads are
  now saved through an allowlisted native "Save As" bridge in the main process
  (`video:download` IPC → preload API), instead of relying only on the browser's
  download path. The renderer requests the save and the shell writes the prepared
  file to the location the user picks. No new permissions or remote access; the
  temporary server copy is still lease-protected and cleaned up as before.

## [0.0.22-bradmisfit.4] - 2026-09-03

### Fixed

- **Update check no longer fails.** 0.0.22-bradmisfit.3 pinned the updater channel
  to `latest`, but our releases live on the `bradmisfit` prerelease channel, so
  electron-updater's GitHub feed matcher found no matching release and reported
  "update check failed". The forced channel is removed: electron-updater now
  matches the `bradmisfit`-channel release and reads `bradmisfit.yml`, falling
  back to `latest.yml`. Releases now ship both manifests so the channel resolves
  directly. Auto-download, the periodic re-check, and the status-bar
  check-for-updates button work as intended.

## [0.0.22-bradmisfit.3] - 2026-09-03

Desktop acceptance fixes for the Browser Workspace.

### Fixed

- **Browser page now fits the workspace.** The visible browser `<webview>` is
  positioned from a fraction of the OWUI guest viewport multiplied by the live
  overlay-container size, instead of the guest's raw pixels. This is invariant to
  the guest webview's zoom factor, Windows display scaling, and DPR, so the page
  no longer lands hundreds of pixels too far right with a black left margin and a
  clipped right edge. The surface is clamped to its rectangle (it can't cover
  other UI) and follows window resize, the chat/workspace splitter, sidebar
  toggle, and maximize/restore via a container resize observer.
- **Auto-update now works.** electron-updater was deriving an update channel from
  our `-bradmisfit.N` version tag and looking for a `bradmisfit.yml` that is never
  published, so updates were found silently or not at all. The channel is now
  pinned to the published `latest.yml` with prerelease updates allowed, downloads
  happen automatically, and a periodic re-check runs for long-lived sessions.

### Added

- **Distinct Browser Workspace icon.** The composer button uses a browser-window
  icon instead of the globe, so it is no longer confused with Web Search, and it
  turns blue (the same active style as the other composer controls) while a
  Browser Workspace is open — derived from real workspace state. Clicking focuses
  an existing Browser Workspace instead of opening a duplicate.
- **Check-for-updates button in the status bar.** A refresh/spinner control next
  to the version checks for updates on demand and shows checking / available /
  downloading / restart state, so a ready update is always visible.

## [0.0.22-bradmisfit.2] - 2026-09-03

Custom BradMisfit build. Adds the **Browser Workspace** and the **Web Security /
Pentest Workspace** to the visible right-side workspace, on top of the existing
Remote Workspace and GitHub Device-Flow bridge.

### Added

- **Browser Workspace (P1 + P2).** A visible, controllable web-browsing surface in
  the right-side workspace (sibling `<webview>` + main-process bridge). P1 manual
  navigation/controls; P2 AI-driven actions (`browser_action`) available to both
  Normal Chat and the Work Agent on the same visible session.
- **Web Security / Pentest Workspace (Phases A–E)** — an AI-assisted Burp/ZAP +
  DevTools built on the Browser Workspace using CDP (`webContents.debugger`) +
  `webRequest`, with no proxy, no hidden browser, and a fail-closed authorized
  **Scope** as the backbone:
  - **A** — capture engine (bounded/redacted), HTTP History, Site Map, Scope, and
    Chromium DevTools, plus read-only `websec` AI inspection.
  - **B** — Intercept (CDP `Fetch` pause/forward/drop/edit) + Repeater
    (scope-gated, protected-auth reuse without exposing secrets).
  - **C** — WebSocket inspection + scope-gated WS repeater, and an API Inspector
    (REST/JSON/GraphQL from traffic + OpenAPI import).
  - **D** — Controlled Fuzzer (hard-bounded, rate-limited, cancelable), passive
    analysis (headers/CSP/CORS/cookies/secrets/source-maps), and Findings/Reports.
  - **E** — active-testing modules (reflected XSS, SQLi, open redirect, path
    traversal, header audit — authorized + scope-gated) and confirmation-gated,
    model-redacted AI operations (`replay_request`, `controlled_fuzz`,
    `passive_scan`, findings) on the `websec` capability.

App identity (`com.openwebui.desktop`), the custom updater feed, Remote Workspace,
and the GitHub Device-Flow bridge are unchanged.

## [0.0.20] - 2026-05-07

### Fixed

- **Blank Webview on Linux.** Replaced the `--in-process-gpu` Chromium flag with SwiftShader software rendering (`--use-gl=angle --use-angle=swiftshader`). The in-process GPU flag broke `<webview>` guest compositing entirely, leaving connection views blank on all Linux configurations. SwiftShader keeps the GPU process out-of-process (required for webview compositing) while avoiding driver-level crashes (#178).

## [0.0.19] - 2026-05-06

### Fixed

- **Spotlight Pulls to First Desktop on macOS.** Spotlight no longer switches Spaces when triggered from a non-primary desktop. The window is now visible on all workspaces, and `app.focus({ steal: true })` — which activated the entire app and caused the Space switch — has been replaced with targeted window-level focus (#179).
- **Gray Screen When Connecting to Server on Linux.** Replaced the `--disable-gpu` Chromium flag with `--in-process-gpu`, which keeps the display compositor alive so `<webview>` guest surfaces actually paint instead of showing a gray rectangle. The previous flag fixed GPU process crashes but broke webview rendering on Debian and Ubuntu (#178).
- **Open Terminal Fails Silently Without Python.** Open Terminal now automatically installs Python when it's missing instead of throwing an opaque error. Progress status is surfaced in the UI during installation.
- **Corrupt Auto-Update Manifests.** Fixed the release workflow to deduplicate artifact entries during manifest merging, preventing SHA512 checksum mismatches that caused updates to fail silently.

## [0.0.18] - 2026-05-05

### Fixed

- **Downloaded Models Not Recognized by llama.cpp.** Models downloaded from Hugging Face are now stored directly under the `models/` directory instead of a nested `models/huggingface/` subdirectory, so llama-server's model scanner discovers them without manual symlinks. Existing models in the old location are automatically migrated on startup (#177).

## [0.0.17] - 2026-05-03

### Added

- **Webview Context Menu.** Right-clicking inside the webview now shows a native context menu with Cut, Copy, Paste, Undo/Redo, spell-check suggestions, and "Open Link in Browser" — enabling system autofill and password manager integration on login pages (#161).

### Changed

- **Windows OpenSSL Compatibility.** The bundled Python's directory is now prepended to `PATH` on Windows so its own OpenSSL DLLs are loaded before any conflicting system-wide installations (Git for Windows, Anaconda, Strawberry Perl, etc.), preventing the `OPENSSL_Uplink: no OPENSSL_Applink` crash on startup (#167).
- **Links Open in Default Browser on Windows.** Added `allowpopups` to the webview so that `target="_blank"` link clicks correctly propagate to the main process handler and open in the default browser instead of being silently blocked (#165, #170).
- **Linux System Requirements.** Documentation now specifies glibc 2.28+ as a minimum requirement for Linux installations.

## [0.0.16] - 2026-05-02

### Fixed

- **Links Open in Default Browser.** Clicking links in chat responses now opens them in the user's default browser instead of navigating within the app or spawning a new Electron window (#165).

## [0.0.15] - 2026-04-28

### Added

- **ARM64 Support for Linux and Windows.** Native ARM64 builds are now produced for Linux (.deb, AppImage) and Windows (NSIS installer), enabling support for Raspberry Pi, NVIDIA DGX Spark, Snapdragon laptops, and other ARM64 devices (#140).

### Fixed

- **Grey/Blank Screen on Linux.** Disabled GPU compositing entirely on Linux to prevent shared memory allocation crashes that caused a grey or blank screen on systems with restricted `/dev/shm` or `/tmp` permissions.
- **Spotlight Dismiss Behavior.** Pressing Escape or the toggle shortcut to dismiss Spotlight no longer erroneously brings the main application window to the foreground (#158).

## [0.0.14] - 2026-04-28

### Fixed

- **Grey/Blank Webview on Linux.** Disabled GPU compositing on Linux to prevent silent compositor failures that produce a grey rectangle instead of rendered content on systems with problematic Intel/NVIDIA drivers or certain Wayland compositors (#119).
- **Renderer Crash Recovery.** The main window now automatically reloads when the renderer process dies unexpectedly, preventing a permanent blank/grey screen.
- **Webview Crash Diagnostics.** Added logging for guest webview renderer crashes to aid debugging connectivity and rendering issues.
- **macOS Notarization.** Resolved Apple notarization failure caused by an expired Developer Program agreement, restoring signed and notarized macOS builds.

## [0.0.13] - 2026-04-27

### Fixed

- **Copy Button on Linux (GNOME/Wayland/Flatpak).** Fixed the "Copy" button in the Open WebUI interface not actually writing to the system clipboard on Linux. The webview session was missing the `clipboard-sanitized-write` permission required by Electron for `navigator.clipboard.writeText()` to work.

## [0.0.12] - 2026-04-25

### Added

- **Toggleable Clipboard Auto-Paste for Spotlight.** Spotlight's automatic clipboard pasting is now optional and can be toggled in Settings, so the input bar starts empty when preferred.
- **Persistent Window Size and Position.** The app now remembers your window dimensions, position, and maximized state across restarts, with safe fallback when a saved display is disconnected.

### Fixed

- **Linux .deb Crash.** Fixed app failing to launch on Linux with `Failed to load native module: pty.node` by enabling native module rebuilds and unpacking node-pty from the asar archive during packaging.
- **Grey Screen on Connection Failure.** The webview now shows an error overlay with retry and open-in-browser options instead of a blank grey screen when a connection fails to load or crashes.
- **Global Shortcuts on Wayland/Flatpak.** Global shortcuts now work on Wayland desktops via `xdg-desktop-portal`, with clear user-facing notifications when a shortcut cannot be registered.

## [0.0.11] - 2026-04-24

### Fixed

- **macOS Launch Crash.** Fixed app failing to launch with "different Team IDs" error by adding the missing `disable-library-validation` entitlement to the build signing configuration.
- **Self-Signed SSL Connections.** The app now trusts all SSL certificates, allowing connections to Open WebUI instances behind self-signed or untrusted certificates without errors.

## [0.0.10] - 2026-04-24

### Added

- **Concurrent Model Downloads.** Multiple Hugging Face models can now be downloaded simultaneously, each with independent progress tracking and per-file cancel buttons.

### Changed

- **Models Settings UI.** Cleaner layout with inline progress bars, hover-reveal download buttons, and breadcrumb-style repo navigation.

### Fixed

- **GPU Process Crash Recovery.** The app now automatically detects GPU process crashes (common with certain NVIDIA/Intel drivers on Windows) and relaunches with the GPU sandbox disabled, instead of closing immediately. No manual shortcut edits required.

## [0.0.9] - 2026-04-20

### Fixed

- **Open Terminal API Key Persistence.** The Open Terminal API key is now saved in config.json and reused across restarts instead of being regenerated on every startup, which was breaking existing integrations.

## [0.0.8] - 2026-04-11

### Added

- **Voice Input.** System-wide push-to-talk voice transcription. Press the shortcut from any app to record audio, which is automatically transcribed and sent to your active chat.
- **Voice Input Settings.** Configurable global hotkey and enable/disable toggle in Settings, with a default of Shift+Cmd+Space (macOS) or Shift+Ctrl+Space (Windows/Linux).
- **Audio Feedback.** Bundled start and stop chime sounds play when recording begins and ends.

### Fixed

- **Shortcut Recorder on macOS.** Shortcut inputs now use physical key codes instead of character values, fixing Alt key combinations producing unicode characters like √ instead of V.

## [0.0.7] - 2026-04-11

### Fixed

- **macOS Auto-Update.** Auto-update now works correctly on macOS. Previously, the updater tried to download a zip file with a versioned filename that did not exist in the release.

## [0.0.6] - 2026-04-10

### Added

- **Spotlight Screenshot Capture.** Drag anywhere on the Spotlight overlay to select a region of your screen. Screenshots appear as inline thumbnails and are sent alongside your message.
- **Multiple Screenshots.** Attach several screenshots in a single Spotlight query. Each one can be individually removed before sending.
- **Click-to-Dismiss Spotlight.** Clicking the background outside the input bar dismisses Spotlight, in addition to pressing Escape.
- **Screen Recording Permission Prompt (macOS).** If screen capture permission hasn't been granted, a notification guides you to the correct System Settings page.
- **Screenshot Hint.** A "Drag anywhere to capture a screenshot" hint appears when Spotlight opens.
- **Offline Mode for llama.cpp.** Previously downloaded llama.cpp binaries are automatically detected on startup, so local models work without an internet connection.
- **Auto-Connect on Startup.** The app pre-connects to your default connection when launched, so Spotlight queries work immediately.

### Changed

- **Fullscreen Spotlight Overlay.** Spotlight now opens as a fullscreen transparent overlay on your active display rather than a small floating window, enabling screenshot capture and multi-display support.
- **Faster Remote Connections.** Switching to a remote server is now instant with no loading delay.
- **Smarter Loading Indicator.** The loading spinner only appears when the local server is actually starting, instead of showing on every connection switch.
- **Clearer Sidebar Selection.** Active connections are more visually distinct with bolder text and stronger highlights. Inactive connections are subtler for better contrast.
- **Safer llama.cpp Updates.** The app verifies internet connectivity before removing the current installation, preventing accidental data loss when updating offline.

### Fixed

- **Tray Menu Connections.** Clicking a connection from the system tray menu now correctly opens it in the app.
- **Dark Mode Context Menus.** Sidebar right-click menus no longer appear incorrectly highlighted in dark mode.
- **Local Server Always Accessible.** The local connection in the sidebar is no longer grayed out when the server isn't running. Clicking it will start the server.
- **Open Terminal Install Errors.** If automatic installation of Open Terminal fails, you now see a clear error message instead of a silent failure.
- **Network Timeout Handling.** Requests for llama.cpp releases now time out after 10 seconds instead of hanging indefinitely on slow networks.

## [0.0.5] - 2026-04-07

### Added

- **Two-Way Theme Sync.** Theme changes in Open WebUI are now mirrored to the desktop app and vice versa, so your light/dark preference stays consistent everywhere.
- **Seamless Spotlight Queries.** Spotlight prompts now appear directly in your already-open chat without triggering a full page reload.

### Fixed

- **Auto-Default Connection.** Selecting a connection now automatically saves it as your default for Spotlight and app startup.
- **Smooth Connection Switching.** Switching between already-open connections no longer causes unnecessary page reloads.
- **Connection Switch Race Condition.** Clicking a remote connection while the local server is still starting no longer gets overridden when the local server finishes loading.

## [0.0.3] - 2026-04-06

### Fixed

- **Spotlight Focus.** Spotlight now reliably appears after interacting with the main window. Previously could fail to show on macOS.
- **Spotlight Search Passthrough.** Searches submitted from Spotlight now correctly load in already-open connections instead of being silently ignored.

## [0.0.2] - 2026-04-06

### Added

- **Spotlight Input Bar.** Lightweight quick-chat bar (⇧⌘I) for submitting queries without opening the full app.
- **Spotlight Shortcut.** Dedicated configurable shortcut for Spotlight, independent from the global app shortcut.
- **Draggable Spotlight.** Spotlight bar can be dragged to any position on screen.
- **Persistent Spotlight Position.** Spotlight position is saved and restored across app restarts.
- **Spotlight Settings.** Shortcut recorder in Settings → General for the Spotlight shortcut.

### Fixed

- **System Theme Sync.** The app now responds to OS dark/light mode changes in real-time when set to "Auto". Previously only checked once at startup.

## [0.0.1] - 2026-03-20

### Added

- **Local Server Management.** Install, start, stop, and restart Open WebUI directly from the desktop app.
- **Connection Manager.** Connect to multiple Open WebUI servers with sidebar quick-switch.
- **Status Bar.** Real-time status indicators for Open WebUI, Open Terminal, and llama.cpp services.
- **Log Viewer.** Live terminal log viewer for all services with copy, refresh, and resize.
- **Open Terminal Integration.** Built-in terminal server for AI-powered shell access.
- **llama.cpp Integration.** Local inference engine with model management and Hugging Face downloads.
- **Settings.** General, Open WebUI, Terminal, Inference, Models, Connections, and About panels.
- **Global Shortcut.** Configurable system-wide hotkey to bring the app to the foreground.
- **Auto-Update.** Built-in update checker with one-click download and install.
- **Tray Support.** System tray icon with quick actions and optional background mode.
- **Factory Reset.** One-click removal of all installed components, data, and connections.
- **Disk Space Check.** Pre-install check requiring at least 5 GB of free storage.
- **Internationalization.** English, Japanese, Chinese (Simplified & Traditional) translations.
- **In-App Changelog.** Accessible from the About settings page.
- **Cross-Platform.** macOS, Windows, and Linux support.
