/**
 * Host-owned display hold for G2 LABS.
 *
 * While any hold reason is active (on-glasses menu overlay, "Pause display"),
 * miniapp display output is still processed and retained by SceneRenderer /
 * LocalDisplayManager, but NOT sent to the glasses. Speech recognition keeps
 * running underneath; on release the host replays the latest retained frame so
 * captions resume instantly with current text instead of restarting.
 *
 * Dependency-free on purpose: imported by both renderers without cycles.
 */

type Listener = (held: boolean) => void

class DisplayHold {
  private reasons = new Set<string>()
  private suppressedApps = new Set<string>()
  private listeners = new Set<Listener>()

  isHeld(): boolean {
    return this.reasons.size > 0
  }

  has(reason: string): boolean {
    return this.reasons.has(reason)
  }

  hold(reason: string): void {
    const was = this.isHeld()
    this.reasons.add(reason)
    if (!was) this.emit(true)
  }

  /** Returns true when this release ended the hold (caller should replay). */
  release(reason: string): boolean {
    if (!this.reasons.delete(reason)) return false
    if (this.isHeld()) return false
    this.emit(false)
    return true
  }

  /** Renderers record which app's output was swallowed so it can be replayed. */
  noteSuppressed(appId: string): void {
    this.suppressedApps.add(appId)
  }

  takeSuppressed(): string[] {
    const apps = [...this.suppressedApps]
    this.suppressedApps.clear()
    return apps
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Test hook. */
  _reset(): void {
    this.reasons.clear()
    this.suppressedApps.clear()
  }

  private emit(held: boolean): void {
    for (const l of this.listeners) {
      try {
        l(held)
      } catch {
        // listener failures must never break display output
      }
    }
  }
}

const displayHold = new DisplayHold()
export default displayHold
export {DisplayHold}
