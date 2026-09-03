<script lang="ts">
  import { fade } from 'svelte/transition'
  import { onMount, onDestroy } from 'svelte'
  import i18n from '../../../i18n'
  import { tooltip } from '../../../actions/tooltip'
  import { appInfo } from '../../../stores'
  import trayIcon from '../../../../../../../resources/tray.png'

  // ── Updater status (always-visible so a launch-time update never stays silent) ──
  type UpdateStatus =
    | 'idle'
    | 'checking'
    | 'available'
    | 'downloading'
    | 'downloaded'
    | 'up-to-date'
    | 'error'
  let updateStatus: UpdateStatus = $state('idle')
  let updateVersion: string | null = $state(null)
  let downloadPercent = $state(0)
  let cleanupData: (() => void) | null = null

  const updateBusy = $derived(updateStatus === 'checking' || updateStatus === 'downloading')
  const updateActionable = $derived(updateStatus === 'available' || updateStatus === 'downloaded')

  function onUpdateClick(): void {
    if (updateBusy) return
    if (updateStatus === 'available') {
      updateStatus = 'downloading'
      downloadPercent = 0
      void window.electronAPI?.downloadUpdate?.()
      return
    }
    if (updateStatus === 'downloaded') {
      window.electronAPI?.installUpdate?.()
      return
    }
    // idle / up-to-date / error → (re)check
    updateStatus = 'checking'
    void window.electronAPI?.checkForUpdates?.()
  }

  const updateTip = $derived(
    updateStatus === 'available'
      ? $i18n.t('statusBar.updateAvailable', { version: updateVersion ?? '' })
      : updateStatus === 'downloading'
        ? $i18n.t('statusBar.updateDownloading', { percent: downloadPercent })
        : updateStatus === 'downloaded'
          ? $i18n.t('statusBar.updateReady')
          : updateStatus === 'checking'
            ? $i18n.t('statusBar.updateChecking')
            : updateStatus === 'up-to-date'
              ? $i18n.t('statusBar.updateUpToDate')
              : updateStatus === 'error'
                ? $i18n.t('statusBar.updateError')
                : $i18n.t('statusBar.checkForUpdates')
  )

  onMount(() => {
    cleanupData = window.electronAPI?.onData?.((data: any) => {
      switch (data?.type) {
        case 'update:checking':
          updateStatus = 'checking'
          break
        case 'update:available':
          updateStatus = 'available'
          updateVersion = data.data?.version ?? null
          break
        case 'update:not-available':
          updateStatus = 'up-to-date'
          break
        case 'update:download-progress':
          updateStatus = 'downloading'
          downloadPercent = Math.round(data.data?.percent ?? 0)
          break
        case 'update:downloaded':
          updateStatus = 'downloaded'
          downloadPercent = 100
          break
        case 'update:error':
          updateStatus = 'error'
          break
      }
    }) ?? null
    // The launch-time check in main can fire before this subscribes, so a ready
    // update would never show. Re-check shortly after mount so the always-visible
    // status bar reflects real state (this is why an update looked "silent").
    setTimeout(() => {
      try {
        void window.electronAPI?.checkForUpdates?.()
      } catch {
        /* no updater in this context */
      }
    }, 1500)
  })
  onDestroy(() => cleanupData?.())

  interface Props {
    serverStatus: string | undefined
    serverReachable: boolean | undefined
    openTerminalStatus: string | null
    llamaCppStatus: string | null
    openWebuiInstalled: boolean
    openTerminalInstalled: boolean
    llamaCppInstalled: boolean
    activeLog: string | null
    onSelectLog: (log: string) => void
    onStartServer: () => void
    onToggleOpenTerminal: () => void
    onToggleLlamaCpp: () => void
  }

  let {
    serverStatus,
    serverReachable,
    openTerminalStatus,
    llamaCppStatus,
    openWebuiInstalled,
    openTerminalInstalled,
    llamaCppInstalled,
    activeLog,
    onSelectLog,
    onStartServer,
    onToggleOpenTerminal,
    onToggleLlamaCpp
  }: Props = $props()

  // Derived server state
  const serverRunning = $derived(serverStatus === 'started' && serverReachable)
  const serverStarting = $derived(
    serverStatus === 'starting' || (serverStatus === 'started' && !serverReachable)
  )

  const otRunning = $derived(openTerminalStatus === 'started')
  const otStarting = $derived(openTerminalStatus === 'starting' || openTerminalStatus === 'stopping')
  const otFailed = $derived(openTerminalStatus === 'failed')

  const lsRunning = $derived(llamaCppStatus === 'started')
  const lsStarting = $derived(
    llamaCppStatus === 'starting' || llamaCppStatus === 'setting-up' || llamaCppStatus === 'stopping'
  )
  const lsFailed = $derived(llamaCppStatus === 'failed')

  // Derived visibility — show each section only when installed or active
  const showServer = $derived(openWebuiInstalled || !!serverStatus)
  const showTerminal = $derived(openTerminalInstalled || !!openTerminalStatus)
  const showLlama = $derived(llamaCppInstalled || !!llamaCppStatus)
</script>

<div
  class="shrink-0 flex items-center gap-1 px-3 h-7 border-t border-black/[0.08] dark:border-white/[0.08] bg-[#ebebed] dark:bg-[#111111]"
  in:fade={{ duration: 150 }}
>
  <!-- Open WebUI logo mark -->
  <img src={trayIcon} alt="" class="w-3.5 opacity-30 mx-0.5 shrink-0 invert dark:invert-0" />

  {#if showServer}
  <!-- Open WebUI status -->
  <button
    class="flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] transition-all bg-transparent border-none cursor-pointer text-[#1d1d1f] dark:text-[#fafafa] {activeLog === 'server'
      ? 'bg-black/[0.08] dark:bg-white/[0.1] opacity-90'
      : 'opacity-50 hover:opacity-80 hover:bg-black/[0.04] dark:hover:bg-white/[0.06]'}"
    onclick={() => {
      if (!serverRunning && !serverStarting) {
        onStartServer()
      }
      onSelectLog('server')
    }}
    use:tooltip={serverRunning
      ? $i18n.t('statusBar.serverRunning')
      : serverStarting
        ? $i18n.t('common.starting')
        : $i18n.t('statusBar.serverStopped')}
  >
    <div class="w-[7px] h-[7px] shrink-0 rounded-full {serverRunning
      ? 'bg-emerald-400 shadow-[0_0_5px_rgba(52,211,153,0.6)]'
      : serverStarting
        ? 'bg-amber-400 animate-pulse'
        : 'bg-black/15 dark:bg-white/20'}">
    </div>
    <span>{$i18n.t('statusBar.server')}</span>
  </button>
  {/if}

  {#if showTerminal}
  {#if showServer}
  <div class="w-px h-3 bg-black/[0.08] dark:bg-white/[0.08] mx-0.5"></div>
  {/if}

  <!-- Open Terminal status -->
  <button
    class="flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] transition-all bg-transparent border-none cursor-pointer text-[#1d1d1f] dark:text-[#fafafa] {activeLog === 'open-terminal'
      ? 'bg-black/[0.08] dark:bg-white/[0.1] opacity-90'
      : 'opacity-50 hover:opacity-80 hover:bg-black/[0.04] dark:hover:bg-white/[0.06]'}"
    onclick={() => {
      if (!otRunning && !otStarting) {
        onToggleOpenTerminal()
      }
      onSelectLog('open-terminal')
    }}
    oncontextmenu={(e) => {
      e.preventDefault()
      if (otRunning) onToggleOpenTerminal()
    }}
    use:tooltip={otRunning
      ? activeLog === 'open-terminal'
        ? $i18n.t('sidebar.tooltip.hideLogs')
        : $i18n.t('sidebar.tooltip.viewLogs')
      : otStarting
        ? $i18n.t('common.starting')
        : otFailed
          ? $i18n.t('sidebar.tooltip.clickToRetry')
          : $i18n.t('sidebar.tooltip.startTerminalServer')}
  >
    <div class="w-[7px] h-[7px] shrink-0 rounded-full {otRunning
      ? 'bg-emerald-400 shadow-[0_0_5px_rgba(52,211,153,0.6)]'
      : otStarting
        ? 'bg-amber-400 animate-pulse'
        : otFailed
          ? 'bg-red-400'
          : 'bg-black/15 dark:bg-white/20'}">
    </div>
    <span>{$i18n.t('sidebar.openTerminal')}</span>
  </button>
  {/if}

  {#if showLlama}
  {#if showServer || showTerminal}
  <div class="w-px h-3 bg-black/[0.08] dark:bg-white/[0.08] mx-0.5"></div>
  {/if}

  <!-- llama.cpp status -->
  <button
    class="flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] transition-all bg-transparent border-none cursor-pointer text-[#1d1d1f] dark:text-[#fafafa] {activeLog === 'llama-server'
      ? 'bg-black/[0.08] dark:bg-white/[0.1] opacity-90'
      : 'opacity-50 hover:opacity-80 hover:bg-black/[0.04] dark:hover:bg-white/[0.06]'}"
    onclick={() => {
      if (!lsRunning && !lsStarting) {
        onToggleLlamaCpp()
      }
      onSelectLog('llama-server')
    }}
    oncontextmenu={(e) => {
      e.preventDefault()
      if (lsRunning) onToggleLlamaCpp()
    }}
    use:tooltip={lsRunning
      ? activeLog === 'llama-server'
        ? $i18n.t('sidebar.tooltip.hideLogs')
        : $i18n.t('sidebar.tooltip.viewLogs')
      : lsStarting
        ? $i18n.t('common.starting')
        : lsFailed
          ? $i18n.t('sidebar.tooltip.clickToRetry')
          : $i18n.t('sidebar.tooltip.startLlamaServer')}
  >
    <div class="w-[7px] h-[7px] shrink-0 rounded-full {lsRunning
      ? 'bg-emerald-400 shadow-[0_0_5px_rgba(52,211,153,0.6)]'
      : lsStarting
        ? 'bg-amber-400 animate-pulse'
        : lsFailed
          ? 'bg-red-400'
          : 'bg-black/15 dark:bg-white/20'}">
    </div>
    <span>{$i18n.t('sidebar.llamaCpp')}</span>
  </button>
  {/if}

  <!-- Version + update check (right-aligned) -->
  <div class="ml-auto flex items-center gap-1">
    <button
      class="flex items-center justify-center rounded-md p-1 border-none bg-transparent cursor-pointer transition-all {updateActionable
        ? 'text-sky-500 dark:text-sky-400 opacity-90 hover:opacity-100'
        : 'text-[#1d1d1f] dark:text-[#fafafa] opacity-25 hover:opacity-70 hover:bg-black/[0.04] dark:hover:bg-white/[0.06]'}"
      onclick={onUpdateClick}
      use:tooltip={updateTip}
      aria-label={$i18n.t('statusBar.checkForUpdates')}
    >
      {#if updateBusy}
        <!-- spinner (checking / downloading) -->
        <svg class="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" stroke-dasharray="31.4 31.4" stroke-linecap="round" />
        </svg>
      {:else}
        <!-- refresh / arrow-path wheel -->
        <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992V4.356M2.985 19.644v-4.992h4.992m-4.053-4.05a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0 4.99a8.25 8.25 0 0 1-13.803 3.7l-3.181-3.182" />
        </svg>
      {/if}
      {#if updateActionable}
        <span class="ml-1 text-[10px] leading-none">
          {updateStatus === 'downloaded' ? $i18n.t('statusBar.updateRestart') : $i18n.t('common.update')}
        </span>
      {/if}
    </button>
    <span class="text-[10px] opacity-25 select-none">v{$appInfo?.version ?? ''}</span>
  </div>
</div>
