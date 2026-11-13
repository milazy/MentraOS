import {describe, expect, test} from "bun:test"

import {
  G2GlassesNavigator,
  type G2NavContext,
  type G2NavEffect,
  buildG2Menus,
} from "../G2GlassesNavigator"

const ctx = (over: Partial<G2NavContext> = {}): G2NavContext => ({
  captionsRunning: true,
  captionsDisplayPaused: false,
  language: "it",
  displayLines: 3,
  captionTimeoutSeconds: 40,
  engineLabel: "Sherpa",
  connected: true,
  glassesBattery: 80,
  caseBattery: 55,
  charging: false,
  apps: [],
  ...over,
})

const actions = (effects: G2NavEffect[] | null) =>
  (effects ?? []).filter((e) => e.type === "action").map((e) => (e as {action: unknown}).action)
const lastText = (effects: G2NavEffect[] | null) =>
  [...(effects ?? [])].reverse().find((e) => e.type === "render") as {text: string} | undefined

/** Drive gestures with enough spacing to clear duplicate/select guards. */
function drive(nav: G2GlassesNavigator, gestures: string[], c = ctx(), start = 1_000) {
  let t = start
  let last: G2NavEffect[] | null = null
  const all: G2NavEffect[] = []
  for (const g of gestures) {
    t += 400
    last = nav.handleGesture(g, c, t)
    all.push(...(last ?? []))
  }
  return {last, all, t}
}

describe("G2GlassesNavigator", () => {
  test("ignores gestures while closed so they reach the running miniapp", () => {
    const nav = new G2GlassesNavigator()
    expect(nav.handleGesture("single_tap", ctx(), 0)).toBeNull()
  })

  test("Home -> Quick Settings -> Language -> English applies, then returns one level", () => {
    const nav = new G2GlassesNavigator()
    nav.openMenu(ctx(), 0)
    // Home: [captions, quick, engine, status, close] -> down to quick, tap
    const {all, last} = drive(nav, ["swipe_down", "single_tap", "single_tap", "swipe_down", "single_tap"])
    expect(actions(all)).toEqual([{type: "captions:set-language", language: "en"}])
    expect(lastText(last)?.text).toContain("QUICK SETTINGS")
    expect(lastText(last)?.text).toContain("Language: English")
    expect(lastText(last)?.text).toContain("Saved")
    expect(nav.snapshot().stack.map((f) => f.menuId)).toEqual(["home", "quick"])
  })

  test("choice submenu opens on the currently selected value", () => {
    const nav = new G2GlassesNavigator()
    nav.openMenu(ctx({displayLines: 4}), 0)
    drive(nav, ["swipe_down", "single_tap", "swipe_down", "single_tap"], ctx({displayLines: 4}))
    const top = nav.snapshot().stack.at(-1)!
    expect(top.menuId).toBe("lines")
    expect(buildG2Menus(ctx({displayLines: 4})).get("lines")!.items[top.cursor].id).toBe("lines:4")
  })

  test("Back row and long press both pop exactly one level; Home back closes", () => {
    const nav = new G2GlassesNavigator()
    nav.openMenu(ctx(), 0)
    drive(nav, ["swipe_down", "single_tap"]) // into quick
    const r = drive(nav, ["long_press", "long_press_release"], ctx(), 5_000)
    expect(nav.snapshot().stack.map((f) => f.menuId)).toEqual(["home"])
    const closed = drive(nav, ["long_press"], ctx(), 9_000)
    expect(closed.last).toEqual([{type: "close", restoreCaptions: true}])
    expect(nav.open).toBe(false)
    expect(r.all.length).toBeGreaterThan(0)
  })

  test("every non-home menu has a reachable Back row (never trapped without long press)", () => {
    const menus = buildG2Menus(ctx({apps: [{packageName: "a.b", name: "Notes", running: false}]}))
    for (const [id, menu] of menus) {
      if (id === "home") {
        expect(menu.items.some((i) => i.kind === "close")).toBe(true)
      } else {
        expect(menu.items.some((i) => i.kind === "back")).toBe(true)
      }
    }
  })

  test("double tap is a global captions shortcut from any depth", () => {
    const nav = new G2GlassesNavigator()
    nav.openMenu(ctx(), 0)
    drive(nav, ["swipe_down", "single_tap", "single_tap"]) // quick -> language
    const {last} = drive(nav, ["double_tap"], ctx(), 5_000)
    expect(actions(last)).toEqual([{type: "captions:open"}])
    expect(last).toContainEqual({type: "close", restoreCaptions: true})
    expect(nav.open).toBe(false)
  })

  test("destructive Stop captions requires a confirming tap; swipe cancels", () => {
    const nav = new G2GlassesNavigator()
    nav.openMenu(ctx(), 0, "quick")
    // quick: language, lines, timeout, pause, stop, back
    const toStop = ["swipe_down", "swipe_down", "swipe_down", "swipe_down", "single_tap"]
    const first = drive(nav, toStop)
    expect(actions(first.all)).toEqual([])
    expect(lastText(first.last)?.text).toContain("Stop captions?")
    const cancelled = drive(nav, ["swipe_down"], ctx(), first.t)
    expect(actions(cancelled.all)).toEqual([])
    expect(lastText(cancelled.last)?.text).toContain("Cancelled")

    const again = drive(nav, ["single_tap", "single_tap"], ctx(), cancelled.t)
    expect(actions(again.all)).toEqual([{type: "captions:stop"}])
  })

  test("duplicate BLE deliveries of one gesture are dropped", () => {
    const nav = new G2GlassesNavigator()
    nav.openMenu(ctx(), 0)
    nav.handleGesture("swipe_down", ctx(), 1_000)
    nav.handleGesture("swipe_down", ctx(), 1_050)
    expect(nav.snapshot().stack[0].cursor).toBe(1)
  })

  test("a tap right after a screen change is ignored (no accidental double select)", () => {
    const nav = new G2GlassesNavigator()
    nav.openMenu(ctx(), 0)
    nav.handleGesture("swipe_down", ctx(), 1_000)
    nav.handleGesture("single_tap", ctx(), 1_400) // enter quick
    const tooSoon = nav.handleGesture("single_tap", ctx(), 1_500)
    expect(tooSoon).toEqual([])
    expect(nav.snapshot().stack.map((f) => f.menuId)).toEqual(["home", "quick"])
  })

  test("idle timeout closes and restores captions", () => {
    const nav = new G2GlassesNavigator({idleTimeoutMs: 10_000})
    nav.openMenu(ctx(), 0)
    expect(nav.tick(9_999)).toEqual([])
    expect(nav.tick(10_000)).toEqual([{type: "close", restoreCaptions: true}])
    expect(nav.open).toBe(false)
  })

  test("firmware system_exit closes without trying to repaint", () => {
    const nav = new G2GlassesNavigator()
    nav.openMenu(ctx(), 0)
    expect(nav.handleGesture("system_exit", ctx(), 100)).toEqual([{type: "close", restoreCaptions: false}])
  })

  test("restore after reconnect keeps the submenu and clamps a stale cursor", () => {
    const nav = new G2GlassesNavigator()
    nav.openMenu(ctx(), 0, "quick")
    const snap = nav.snapshot()
    snap.stack[1].cursor = 99
    const fresh = new G2GlassesNavigator()
    const effects = fresh.restore(snap, ctx(), 5_000)
    expect(lastText(effects)?.text).toContain("QUICK SETTINGS")
    fresh.handleGesture("swipe_up", ctx(), 6_000)
    expect(fresh.snapshot().stack.at(-1)!.menuId).toBe("quick")
  })

  test("restore drops a submenu that no longer exists (apps uninstalled)", () => {
    const withApps = ctx({apps: [{packageName: "x", name: "Notes", running: false}]})
    const nav = new G2GlassesNavigator()
    nav.openMenu(withApps, 0, "apps")
    const fresh = new G2GlassesNavigator()
    fresh.restore(nav.snapshot(), ctx({apps: []}), 1_000)
    expect(fresh.snapshot().stack.map((f) => f.menuId)).toEqual(["home"])
  })

  test("Stop row disappears when captions are off; cursor never points past the end", () => {
    const nav = new G2GlassesNavigator()
    nav.openMenu(ctx(), 0, "quick")
    drive(nav, ["swipe_up", "swipe_up"]) // wrap to stop (index 4)
    const text = nav.render(ctx({captionsRunning: false}))
    expect(text).not.toContain("Stop captions")
    expect(text.split("\n").filter((l) => l.startsWith(">")).length).toBe(1)
  })

  test("rendered pages stay within G2 text limits and use ASCII-safe pointers", () => {
    const apps = Array.from({length: 18}, (_, i) => ({
      packageName: `p${i}`,
      name: `A very long miniapp display name number ${i}`,
      running: i % 2 === 0,
    }))
    const nav = new G2GlassesNavigator()
    nav.openMenu(ctx({apps}), 0, "apps")
    const text = nav.render(ctx({apps}))
    expect(text.length).toBeLessThan(1000)
    expect(text.split("\n").length).toBeLessThanOrEqual(8)
    for (const line of text.split("\n")) expect(line.length).toBeLessThanOrEqual(34)
    expect(text).toContain("1/19")
  })
})
