/**
 * G2 LABS on-glasses shell: binds the pure G2GlassesNavigator to real stores,
 * the G2 display and the bundled Captions miniapp.
 *
 * Accessibility contract (the user is deaf; captions come first):
 *   - Opening the menu NEVER stops speech recognition. Caption output is held
 *     (DisplayHold) and the newest caption is replayed when the menu closes.
 *   - Caption settings (language, lines, hold time) are applied to the running
 *     Captions session live via its UI channel — no restart, no lost words.
 *   - Double tap anywhere in the menu returns straight to Live Captions.
 *   - The menu always times out back to captions; it can never trap the user.
 *
 * Capability honesty: G2 has one firmware font with no size control, so there
 * is no "text size" setting here; "lines" is the real readability control.
 */

import BluetoothSdk from "@mentra/bluetooth-sdk/internal"

import {useAppStatusStore} from "../stores/apps"
import {useGlassesStore} from "../stores/glasses"
import {useSettingsStore} from "../stores/settings"
import {BgTimer} from "../utils/timers"
import displayHold from "./DisplayHold"
import g2SpeechQuickMenu from "./G2SpeechQuickMenu"
import {
  applyOptimistic,
  G2GlassesNavigator,
  type G2NavAction,
  type G2NavContext,
  type G2NavEffect,
  type G2NavSnapshot,
} from "./G2GlassesNavigator"
import {isGlassesConnected} from "./GlassesReadiness"
import localDisplayManager from "./LocalDisplayManager"
import localMiniappRuntime from "./LocalMiniappRuntime"
import {getMiniappEngine} from "./MiniappEngine"
import sceneRenderer from "./SceneRenderer"

const CAPTIONS_PACKAGE = "com.mentra.captions"
const MENU_HOLD = "g2-menu"
const PAUSE_HOLD = "g2-pause"
const TICK_MS = 1_000

type CaptionSettingKey = "language" | "displayLines" | "captionTimeoutSeconds"

const UI_CHANNEL: Record<CaptionSettingKey, string> = {
  language: "captions:set-language",
  displayLines: "captions:set-display-lines",
  captionTimeoutSeconds: "captions:set-caption-timeout",
}

class G2GlassesShell {
  private nav = new G2GlassesNavigator()
  private ctx: G2NavContext | null = null
  private tickId: number | null = null
  private lastSnapshot: G2NavSnapshot | null = null

  isOpen(): boolean {
    return this.nav.open
  }

  isCaptionsDisplayPaused(): boolean {
    return displayHold.has(PAUSE_HOLD)
  }

  /** Open the on-glasses Home (from the native dashboard "Captions" item or a gesture). */
  async open(at: string = "home"): Promise<void> {
    displayHold.hold(MENU_HOLD)
    const ctx = await this.refreshContext()
    this.run(this.nav.openMenu(ctx, Date.now(), at))
    this.startTicking()
  }

  /** Returns true when the gesture was consumed by the shell. */
  handleTouch(event: {gestureName?: string; kind?: string}): boolean {
    if (!this.nav.open || !this.ctx) return false
    const gesture = event.gestureName ?? event.kind ?? ""
    const effects = this.nav.handleGesture(gesture, this.ctx, Date.now())
    if (effects === null) return false
    this.run(effects)
    return true
  }

  /**
   * Glasses dropped while the menu was open. Keep the navigation position so
   * the user lands where they were once both arms are back.
   */
  onDisconnected(): void {
    if (!this.nav.open) return
    this.lastSnapshot = this.nav.snapshot()
    this.nav.closeMenu()
    this.stopTicking()
    // Keep MENU_HOLD: nothing renders while disconnected anyway, and releasing
    // would replay captions over a menu we are about to restore.
  }

  /** Glasses fully booted again: restore menu position or release the hold. */
  async onReconnected(): Promise<void> {
    const snap = this.lastSnapshot
    this.lastSnapshot = null
    if (snap?.open) {
      const ctx = await this.refreshContext()
      this.run(this.nav.restore(snap, ctx, Date.now()))
      this.startTicking()
      return
    }
    if (displayHold.has(MENU_HOLD)) this.releaseAndRestore(MENU_HOLD)
  }

  // ---------------------------------------------------------------------------

  private run(effects: G2NavEffect[]): void {
    for (const effect of effects) {
      switch (effect.type) {
        case "render":
          void Promise.resolve(BluetoothSdk.displayText(effect.text)).catch((err) =>
            console.warn("G2 shell: menu render failed", err),
          )
          break
        case "close":
          this.stopTicking()
          if (effect.restoreCaptions) this.releaseAndRestore(MENU_HOLD)
          else displayHold.release(MENU_HOLD)
          break
        case "action":
          void this.execute(effect.action)
          break
      }
    }
  }

  private releaseAndRestore(reason: string): void {
    const ended = displayHold.release(reason)
    displayHold.takeSuppressed()
    if (!ended) {
      // Still paused: show an honest placeholder instead of a frozen menu.
      if (displayHold.has(PAUSE_HOLD)) {
        void Promise.resolve(BluetoothSdk.displayText("Captions paused\n\nDouble tap: resume")).catch(() => undefined)
      }
      return
    }
    // Newest retained caption comes back immediately (create-based replay).
    sceneRenderer.markViewStale("main")
    if (!localDisplayManager.replayCurrent()) {
      void Promise.resolve(BluetoothSdk.clearDisplay()).catch(() => undefined)
    }
  }

  private async execute(action: G2NavAction): Promise<void> {
    try {
      switch (action.type) {
        case "captions:open":
          displayHold.release(PAUSE_HOLD)
          await this.ensureCaptionsRunning()
          // If the hold already ended (menu closed first), make sure the
          // latest caption is on screen.
          if (!displayHold.isHeld()) localDisplayManager.replayCurrent()
          return
        case "captions:stop":
          await useAppStatusStore.getState().stop(CAPTIONS_PACKAGE)
          displayHold.release(PAUSE_HOLD)
          break
        case "captions:set-display-paused":
          if (action.paused) displayHold.hold(PAUSE_HOLD)
          else displayHold.release(PAUSE_HOLD)
          break
        case "captions:set-language":
          await this.applyCaptionSetting("language", action.language, {language: action.language})
          break
        case "captions:set-display-lines":
          await this.applyCaptionSetting("displayLines", String(action.lines), {lines: action.lines})
          break
        case "captions:set-caption-timeout":
          await this.applyCaptionSetting("captionTimeoutSeconds", String(action.seconds), {seconds: action.seconds})
          break
        case "engine-menu:open":
          // The engine chooser owns the display and restarts Captions itself
          // (an engine switch changes the transcription subscription).
          displayHold.release(MENU_HOLD)
          await g2SpeechQuickMenu.open()
          return
        case "app:toggle": {
          const store = useAppStatusStore.getState()
          const app = store.apps.find((a) => a.packageName === action.packageName)
          if (!app) break
          if (app.running) await store.stop(app.packageName)
          else await store.start(app, {skipNavigation: true})
          break
        }
      }
    } catch (error) {
      console.warn(`G2 shell: action ${action.type} failed`, error)
    }
    if (action.type.startsWith("captions:set-") && this.ctx) {
      // The running controller persists asynchronously; re-reading storage now
      // could flash the old value. Keep the applied value as the source of truth.
      this.ctx = applyOptimistic(this.ctx, action)
      return
    }
    await this.refreshContext()
  }

  /**
   * Live sessions get the change through their UI channel (the controller
   * persists it itself and re-renders). Stopped sessions get it in storage so
   * the next start uses it. Never both, to avoid racing writes.
   */
  private async applyCaptionSetting(key: CaptionSettingKey, stored: string, payload: unknown): Promise<void> {
    if (this.captionsRunning()) {
      const engine = getMiniappEngine()
      if (engine) {
        engine.uiRouter.sendHostMessage(CAPTIONS_PACKAGE, UI_CHANNEL[key], payload)
        return
      }
    }
    await localMiniappRuntime.setMiniappStorageValue(CAPTIONS_PACKAGE, key, stored)
  }

  private captionsRunning(): boolean {
    return useAppStatusStore.getState().apps.find((a) => a.packageName === CAPTIONS_PACKAGE)?.running === true
  }

  private async ensureCaptionsRunning(): Promise<void> {
    const store = useAppStatusStore.getState()
    let app = store.apps.find((a) => a.packageName === CAPTIONS_PACKAGE)
    if (!app) {
      await store.refresh()
      app = useAppStatusStore.getState().apps.find((a) => a.packageName === CAPTIONS_PACKAGE)
    }
    if (!app) {
      void Promise.resolve(BluetoothSdk.displayText("Captions app is not installed")).catch(() => undefined)
      return
    }
    if (!app.running) await useAppStatusStore.getState().start(app, {skipNavigation: true})
  }

  private async refreshContext(): Promise<G2NavContext> {
    const read = async (key: string): Promise<string | null> => {
      try {
        const v = await localMiniappRuntime.getMiniappStorageValue(CAPTIONS_PACKAGE, key)
        return v == null ? null : String(v)
      } catch {
        return null
      }
    }
    const [language, lines, timeout] = await Promise.all([
      read("language"),
      read("displayLines"),
      read("captionTimeoutSeconds"),
    ])
    const glasses = useGlassesStore.getState()
    const engine = String(useSettingsStore.getState().getSetting("g2_offline_engine") ?? "sherpa")
    const offline = await read("useOfflineStt")
    const apps = useAppStatusStore
      .getState()
      .apps.filter((a) => a.packageName !== CAPTIONS_PACKAGE && !a.hidden && a.local)
      .slice(0, 18)
      .map((a) => ({packageName: a.packageName, name: a.name || a.packageName, running: a.running === true}))

    const parsedLines = parseInt(lines ?? "", 10)
    const parsedTimeout = parseInt(timeout ?? "", 10)
    this.ctx = {
      captionsRunning: this.captionsRunning(),
      captionsDisplayPaused: displayHold.has(PAUSE_HOLD),
      language: language || "auto",
      displayLines: Number.isFinite(parsedLines) ? parsedLines : 3,
      captionTimeoutSeconds: Number.isFinite(parsedTimeout) ? parsedTimeout : 40,
      engineLabel:
        offline === "false" ? "Cloud" : engine.startsWith("whisper_") ? engine.replace("whisper_", "Whisper ") : "Sherpa",
      connected: isGlassesConnected(glasses.connection),
      glassesBattery: glasses.batteryLevel >= 0 ? glasses.batteryLevel : null,
      caseBattery: glasses.caseBatteryLevel >= 0 ? glasses.caseBatteryLevel : null,
      charging: glasses.charging,
      apps,
    }
    return this.ctx
  }

  private startTicking(): void {
    if (this.tickId !== null) return
    this.tickId = BgTimer.setInterval(() => {
      this.run(this.nav.tick(Date.now()))
    }, TICK_MS)
  }

  private stopTicking(): void {
    if (this.tickId === null) return
    BgTimer.clearInterval(this.tickId)
    this.tickId = null
  }
}

const g2GlassesShell = new G2GlassesShell()
export default g2GlassesShell
