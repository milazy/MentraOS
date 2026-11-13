/**
 * G2 LABS on-glasses navigation state machine.
 *
 * Pure and deterministic: no BluetoothSdk, stores, timers or clocks are touched
 * here. The host (G2GlassesShell) feeds gestures + a context snapshot + `nowMs`,
 * and executes the returned `effects`. That keeps every navigation rule unit
 * testable without glasses and lets the shell rebuild the exact same state after
 * a Bluetooth reconnect.
 *
 * Hardware facts this is designed around (Even Hub docs + G2.swift):
 *   - Input: single press, double press, swipe up, swipe down on the temple
 *     touchpads / R1 ring; long press + release only on newer firmware.
 *   - The OS reserves "tap then long press" for its own contextual menu, so long
 *     press is NEVER the only path: every level also has an explicit Back row.
 *   - One built-in LVGL font, no size/bold control, 576x288 greyscale. Menus are
 *     plain text with an ASCII pointer; glyphs outside the font are dropped.
 *
 * Tree:  Home -> Live Captions | Quick Settings | Speech engine | Apps | Status
 *        Quick Settings -> Language | Lines | Caption timeout | Pause display
 */

export type G2Gesture =
  | "single_tap"
  | "double_tap"
  | "swipe_up"
  | "swipe_down"
  | "long_press"
  | "long_press_release"
  | "foreground_exit"
  | "system_exit"

export type G2NavAction =
  | {type: "captions:open"} // start if needed, then show captions
  | {type: "captions:stop"}
  | {type: "captions:set-display-paused"; paused: boolean}
  | {type: "captions:set-language"; language: string}
  | {type: "captions:set-display-lines"; lines: number}
  | {type: "captions:set-caption-timeout"; seconds: number}
  | {type: "engine-menu:open"}
  | {type: "app:toggle"; packageName: string}

export type G2NavEffect =
  | {type: "render"; text: string}
  | {type: "close"; restoreCaptions: boolean}
  | {type: "action"; action: G2NavAction}

export interface G2NavContext {
  captionsRunning: boolean
  captionsDisplayPaused: boolean
  language: string
  displayLines: number
  captionTimeoutSeconds: number
  engineLabel: string
  connected: boolean
  glassesBattery: number | null
  caseBattery: number | null
  charging: boolean
  apps: ReadonlyArray<{packageName: string; name: string; running: boolean}>
}

export interface G2NavOptions {
  /** Idle time after which the menu closes and captions are restored. */
  idleTimeoutMs: number
  /** Repeated identical gestures inside this window are dropped (BLE dupes). */
  duplicateWindowMs: number
  /** Selections are ignored this long after the screen changed (anti double-select). */
  selectGuardMs: number
}

export const DEFAULT_G2_NAV_OPTIONS: G2NavOptions = {
  idleTimeoutMs: 12_000,
  duplicateWindowMs: 180,
  selectGuardMs: 250,
}

export const G2_CAPTION_LANGUAGES: ReadonlyArray<{code: string; label: string}> = [
  {code: "it", label: "Italiano"},
  {code: "en", label: "English"},
  {code: "auto", label: "Auto detect"},
]
export const G2_DISPLAY_LINE_OPTIONS = [2, 3, 4, 5] as const
/** Must mirror miniapps/captions/src/shared/types.ts CAPTION_TIMEOUT_OPTIONS_SECONDS. */
export const G2_CAPTION_TIMEOUT_OPTIONS = [3, 5, 10, 30, 40] as const

type ItemKind = "submenu" | "action" | "choice" | "info" | "back" | "close"

export interface G2MenuItem {
  id: string
  label: string
  kind: ItemKind
  /** submenu target id */
  target?: string
  action?: G2NavAction
  /** choice rows: whether this is the current value */
  selected?: boolean
  /** action rows that need an explicit second tap */
  confirm?: string
}

export interface G2Menu {
  id: string
  title: string
  items: G2MenuItem[]
}

interface Frame {
  menuId: string
  cursor: number
}

interface PendingConfirm {
  item: G2MenuItem
}

export interface G2NavSnapshot {
  open: boolean
  stack: Frame[]
  pendingConfirm: string | null
  status: string
}

const MAX_VISIBLE_ROWS = 5
const MAX_LABEL = 28

function langLabel(code: string): string {
  return G2_CAPTION_LANGUAGES.find((l) => l.code === code)?.label ?? code
}

function pct(value: number | null): string {
  return value == null || value < 0 ? "--" : `${Math.round(value)}%`
}

/** Build the whole tree from live context. Ids are stable across rebuilds. */
export function buildG2Menus(ctx: G2NavContext): Map<string, G2Menu> {
  const menus = new Map<string, G2Menu>()
  const back: G2MenuItem = {id: "back", label: "< Back", kind: "back"}

  menus.set("home", {
    id: "home",
    title: "G2 LABS",
    items: [
      {
        id: "captions",
        label: ctx.captionsRunning ? "Live Captions (on)" : "Live Captions",
        kind: "action",
        action: {type: "captions:open"},
      },
      {id: "quick", label: "Quick Settings", kind: "submenu", target: "quick"},
      {id: "engine", label: `Speech: ${ctx.engineLabel}`, kind: "action", action: {type: "engine-menu:open"}},
      ...(ctx.apps.length > 0 ? [{id: "apps", label: "Apps", kind: "submenu" as const, target: "apps"}] : []),
      {id: "status", label: "Status", kind: "submenu", target: "status"},
      {id: "close", label: "Close menu", kind: "close"},
    ],
  })

  menus.set("quick", {
    id: "quick",
    title: "QUICK SETTINGS",
    items: [
      {id: "language", label: `Language: ${langLabel(ctx.language)}`, kind: "submenu", target: "language"},
      {id: "lines", label: `Lines: ${ctx.displayLines}`, kind: "submenu", target: "lines"},
      {id: "timeout", label: `Caption hold: ${ctx.captionTimeoutSeconds}s`, kind: "submenu", target: "timeout"},
      {
        id: "pause",
        label: ctx.captionsDisplayPaused ? "Resume display" : "Pause display",
        kind: "action",
        action: {type: "captions:set-display-paused", paused: !ctx.captionsDisplayPaused},
      },
      ...(ctx.captionsRunning
        ? [
            {
              id: "stop",
              label: "Stop captions",
              kind: "action" as const,
              action: {type: "captions:stop"} as G2NavAction,
              confirm: "Stop captions?",
            },
          ]
        : []),
      back,
    ],
  })

  menus.set("language", {
    id: "language",
    title: "CAPTION LANGUAGE",
    items: [
      ...G2_CAPTION_LANGUAGES.map((l) => ({
        id: `lang:${l.code}`,
        label: l.label,
        kind: "choice" as const,
        selected: ctx.language === l.code,
        action: {type: "captions:set-language", language: l.code} as G2NavAction,
      })),
      back,
    ],
  })

  menus.set("lines", {
    id: "lines",
    title: "CAPTION LINES",
    items: [
      ...G2_DISPLAY_LINE_OPTIONS.map((n) => ({
        id: `lines:${n}`,
        label: `${n} lines`,
        kind: "choice" as const,
        selected: ctx.displayLines === n,
        action: {type: "captions:set-display-lines", lines: n} as G2NavAction,
      })),
      back,
    ],
  })

  menus.set("timeout", {
    id: "timeout",
    title: "CAPTION HOLD",
    items: [
      ...G2_CAPTION_TIMEOUT_OPTIONS.map((s) => ({
        id: `timeout:${s}`,
        label: `${s} seconds`,
        kind: "choice" as const,
        selected: ctx.captionTimeoutSeconds === s,
        action: {type: "captions:set-caption-timeout", seconds: s} as G2NavAction,
      })),
      back,
    ],
  })

  if (ctx.apps.length > 0) {
    menus.set("apps", {
      id: "apps",
      title: "APPS",
      items: [
        ...ctx.apps.map((app) => ({
          id: `app:${app.packageName}`,
          label: app.running ? `${app.name} (on)` : app.name,
          kind: "action" as const,
          action: {type: "app:toggle", packageName: app.packageName} as G2NavAction,
        })),
        back,
      ],
    })
  }

  menus.set("status", {
    id: "status",
    title: "STATUS",
    items: [
      {id: "st:link", label: ctx.connected ? "Glasses: connected" : "Glasses: reconnecting", kind: "info"},
      {
        id: "st:bat",
        label: `Battery: ${pct(ctx.glassesBattery)}${ctx.charging ? " charging" : ""}`,
        kind: "info",
      },
      {id: "st:case", label: `Case: ${pct(ctx.caseBattery)}`, kind: "info"},
      {id: "st:cap", label: ctx.captionsRunning ? "Captions: running" : "Captions: off", kind: "info"},
      back,
    ],
  })

  return menus
}

function crop(label: string): string {
  const clean = label.replace(/\s+/g, " ").trim()
  return clean.length <= MAX_LABEL ? clean : `${clean.slice(0, MAX_LABEL - 1)}.`
}

export class G2GlassesNavigator {
  private opts: G2NavOptions
  private isOpen = false
  private stack: Frame[] = []
  private confirm: PendingConfirm | null = null
  private status = ""
  private lastGesture: {name: string; at: number} | null = null
  private lastScreenChangeAt = 0
  private lastActivityAt = 0

  constructor(options: Partial<G2NavOptions> = {}) {
    this.opts = {...DEFAULT_G2_NAV_OPTIONS, ...options}
  }

  get open(): boolean {
    return this.isOpen
  }

  snapshot(): G2NavSnapshot {
    return {
      open: this.isOpen,
      stack: this.stack.map((f) => ({...f})),
      pendingConfirm: this.confirm?.item.id ?? null,
      status: this.status,
    }
  }

  /** Re-adopt a snapshot (e.g. after reconnect). Invalid frames are pruned to Home. */
  restore(snap: G2NavSnapshot, ctx: G2NavContext, nowMs: number): G2NavEffect[] {
    if (!snap.open) return []
    const menus = buildG2Menus(ctx)
    const stack = snap.stack.filter((f) => menus.has(f.menuId))
    this.stack = stack.length > 0 && stack[0].menuId === "home" ? stack : [{menuId: "home", cursor: 0}]
    this.confirm = null
    this.status = ""
    this.isOpen = true
    this.lastActivityAt = nowMs
    this.lastScreenChangeAt = nowMs
    return [this.renderEffect(ctx)]
  }

  /** Open at Home (or a specific top-level menu). Idempotent. */
  openMenu(ctx: G2NavContext, nowMs: number, at: string = "home"): G2NavEffect[] {
    const menus = buildG2Menus(ctx)
    this.isOpen = true
    this.confirm = null
    this.status = ""
    this.stack = [{menuId: "home", cursor: 0}]
    if (at !== "home" && menus.has(at)) this.stack.push({menuId: at, cursor: 0})
    this.lastActivityAt = nowMs
    this.lastScreenChangeAt = nowMs
    return [this.renderEffect(ctx, menus)]
  }

  /** Close without side effects; captions are restored by the host. */
  closeMenu(): G2NavEffect[] {
    if (!this.isOpen) return []
    this.isOpen = false
    this.stack = []
    this.confirm = null
    return [{type: "close", restoreCaptions: true}]
  }

  /** Host calls this periodically. Closes after inactivity so no one is trapped. */
  tick(nowMs: number): G2NavEffect[] {
    if (!this.isOpen) return []
    if (nowMs - this.lastActivityAt >= this.opts.idleTimeoutMs) return this.closeMenu()
    return []
  }

  /**
   * Handle a gesture while the menu is open. Returns null when the menu is
   * closed (the gesture is not ours), otherwise the effects to execute.
   */
  handleGesture(gesture: string, ctx: G2NavContext, nowMs: number): G2NavEffect[] | null {
    if (!this.isOpen) return null

    // Firmware page teardown: close cleanly, never leave a dangling state.
    if (gesture === "system_exit" || gesture === "foreground_exit") {
      this.isOpen = false
      this.stack = []
      this.confirm = null
      return [{type: "close", restoreCaptions: false}]
    }

    // De-duplicate BLE double deliveries of the same gesture.
    if (
      this.lastGesture &&
      this.lastGesture.name === gesture &&
      nowMs - this.lastGesture.at < this.opts.duplicateWindowMs
    ) {
      return []
    }
    this.lastGesture = {name: gesture, at: nowMs}
    this.lastActivityAt = nowMs

    const menus = buildG2Menus(ctx)
    this.pruneStack(menus)

    // Pending confirmation: tap = yes, anything else = cancel.
    if (this.confirm) {
      const item = this.confirm.item
      this.confirm = null
      if (gesture === "single_tap" && item.action) {
        return this.runAction(item.action, ctx, menus, nowMs)
      }
      this.status = "Cancelled"
      return [this.renderEffect(ctx, menus)]
    }

    switch (gesture) {
      case "swipe_up":
        this.move(-1, menus)
        this.status = ""
        return [this.renderEffect(ctx, menus)]
      case "swipe_down":
        this.move(1, menus)
        this.status = ""
        return [this.renderEffect(ctx, menus)]
      case "single_tap":
        if (nowMs - this.lastScreenChangeAt < this.opts.selectGuardMs) return []
        return this.select(ctx, menus, nowMs)
      case "double_tap":
        // Global shortcut: straight back to Live Captions from any depth.
        this.isOpen = false
        this.stack = []
        return [{type: "action", action: {type: "captions:open"}}, {type: "close", restoreCaptions: true}]
      case "long_press":
        return this.back(ctx, menus, nowMs)
      case "long_press_release":
        // Release after a handled press is a no-op (prevents a double back).
        return []
      default:
        return []
    }
  }

  private pruneStack(menus: Map<string, G2Menu>): void {
    this.stack = this.stack.filter((f) => menus.has(f.menuId))
    if (this.stack.length === 0) this.stack = [{menuId: "home", cursor: 0}]
    for (const frame of this.stack) {
      const count = menus.get(frame.menuId)!.items.length
      frame.cursor = Math.min(Math.max(0, frame.cursor), count - 1)
    }
  }

  private top(): Frame {
    return this.stack[this.stack.length - 1]
  }

  private move(delta: number, menus: Map<string, G2Menu>): void {
    const frame = this.top()
    const count = menus.get(frame.menuId)!.items.length
    frame.cursor = (frame.cursor + delta + count) % count
  }

  private push(menuId: string, menus: Map<string, G2Menu>, nowMs: number): void {
    const items = menus.get(menuId)!.items
    const selected = items.findIndex((i) => i.selected)
    this.stack.push({menuId, cursor: selected >= 0 ? selected : 0})
    this.lastScreenChangeAt = nowMs
  }

  private back(ctx: G2NavContext, menus: Map<string, G2Menu>, nowMs: number): G2NavEffect[] {
    this.status = ""
    if (this.stack.length <= 1) return this.closeMenu()
    this.stack.pop()
    this.lastScreenChangeAt = nowMs
    return [this.renderEffect(ctx, menus)]
  }

  private select(ctx: G2NavContext, menus: Map<string, G2Menu>, nowMs: number): G2NavEffect[] {
    const frame = this.top()
    const item = menus.get(frame.menuId)!.items[frame.cursor]
    switch (item.kind) {
      case "submenu":
        this.status = ""
        this.push(item.target!, menus, nowMs)
        return [this.renderEffect(ctx, menus)]
      case "back":
        return this.back(ctx, menus, nowMs)
      case "close":
        return this.closeMenu()
      case "info":
        return []
      case "choice":
      case "action":
        if (!item.action) return []
        if (item.confirm) {
          this.confirm = {item}
          return [this.renderEffect(ctx, menus)]
        }
        return this.runAction(item.action, ctx, menus, nowMs, item.kind === "choice")
    }
  }

  private runAction(
    action: G2NavAction,
    ctx: G2NavContext,
    menus: Map<string, G2Menu>,
    nowMs: number,
    popAfter = false,
  ): G2NavEffect[] {
    // Actions that hand the display to someone else close the menu first.
    if (action.type === "captions:open" || action.type === "engine-menu:open") {
      this.isOpen = false
      this.stack = []
      return [
        {type: "close", restoreCaptions: action.type === "captions:open"},
        {type: "action", action},
      ]
    }
    if (action.type === "captions:stop") {
      this.status = "Captions stopped"
    } else {
      this.status = "Saved"
    }
    const effects: G2NavEffect[] = [{type: "action", action}]
    if (popAfter && this.stack.length > 1) {
      this.stack.pop()
      this.lastScreenChangeAt = nowMs
    }
    // Render with the optimistic value so the row shows the new state immediately.
    const optimistic = applyOptimistic(ctx, action)
    effects.push(this.renderEffect(optimistic))
    return effects
  }

  private renderEffect(ctx: G2NavContext, menus?: Map<string, G2Menu>): G2NavEffect {
    return {type: "render", text: this.render(ctx, menus)}
  }

  /** Plain-text page for the G2 text container (≈ 8 short lines). */
  render(ctx: G2NavContext, prebuilt?: Map<string, G2Menu>): string {
    const menus = prebuilt ?? buildG2Menus(ctx)
    const frame = this.top() ?? {menuId: "home", cursor: 0}
    const menu = menus.get(frame.menuId) ?? menus.get("home")!

    if (this.confirm) {
      return [menu.title, "", crop(this.confirm.item.confirm ?? "Confirm?"), "", "Tap = yes", "Swipe = cancel"].join(
        "\n",
      )
    }

    const items = menu.items
    frame.cursor = Math.min(Math.max(0, frame.cursor), items.length - 1)
    const start = Math.max(0, Math.min(frame.cursor - 2, items.length - MAX_VISIBLE_ROWS))
    const rows: string[] = []
    for (let i = start; i < Math.min(items.length, start + MAX_VISIBLE_ROWS); i += 1) {
      const it = items[i]
      const pointer = i === frame.cursor ? ">" : " "
      const mark = it.kind === "choice" && it.selected ? " *" : ""
      rows.push(`${pointer} ${crop(it.label)}${mark}`)
    }
    const position = items.length > MAX_VISIBLE_ROWS ? ` ${frame.cursor + 1}/${items.length}` : ""
    const footer = this.status || "Swipe move  Tap select"
    return [`${menu.title}${position}`, ...rows, "", footer].join("\n")
  }
}

export function applyOptimistic(ctx: G2NavContext, action: G2NavAction): G2NavContext {
  switch (action.type) {
    case "captions:set-language":
      return {...ctx, language: action.language}
    case "captions:set-display-lines":
      return {...ctx, displayLines: action.lines}
    case "captions:set-caption-timeout":
      return {...ctx, captionTimeoutSeconds: action.seconds}
    case "captions:set-display-paused":
      return {...ctx, captionsDisplayPaused: action.paused}
    case "captions:stop":
      return {...ctx, captionsRunning: false}
    default:
      return ctx
  }
}
