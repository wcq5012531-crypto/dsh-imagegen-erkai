/**
 * Add a two-tab switcher above the shell's own New Session affordance:
 * Session (the conversation view) and Image Generation. The shell button stays
 * visible underneath, so creating a new session keeps its old position and the
 * switcher never doubles as the only way out of the studio. When image
 * generation is active, the plugin also uses the shell's region area as a
 * dedicated history surface; the original workspace/session tree remains
 * underneath and is restored when the panel closes.
 */

import type { ImageGenController } from './controller.ts'
import css from './panel.module.css'

/** Stable selector for the injected two-tab host. */
export const ENTRY_SELECTOR = '[data-dsh-imagegen-studio-session-tabs]'
/** Stable selector for the history surface in the shell region area. */
export const HISTORY_HOST_SELECTOR = '[data-dsh-imagegen-studio-history-host]'

/** Inline picture glyph kept deliberately small for the sidebar rail. */
const IMAGE_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="1.5"/><circle cx="5.6" cy="5.8" r="1"/><path d="M2.5 12.5l3.6-3.4 2.4 2.2 3-3 2 2.4"/></svg>'

/** Inline conversation glyph for the session-view tab. */
const SESSION_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 3h11v8H7l-3 2.4V11H2.5z"/></svg>'

/**
 * Sidebar column markers: the web shell names its grid column `sidebarCol`
 * (AppFrame) or exposes `data-pane="sidebar"`; DSH Desktop renders the upstream
 * sidebar inside a surface of its own instead (#20).
 */
const SIDEBAR_COLUMN_SELECTOR = [
  '[data-pane="sidebar"]',
  '[class*="sidebarCol"]',
  '[class*="dshDesktopSidebarSurface"]',
  '[class*="dshDesktopUpstreamSidebar"]',
].join(', ')

/** Accessible names the shell gives its New Session affordance. */
const NEW_SESSION_LABELS = ['new session', 'new chat', '新会话', '新建会话', '新对话', '新话题']

/** Loose New Session match for shells without a stable class or data hook. */
function looksLikeNewSession(button: HTMLButtonElement): boolean {
  const name = `${button.getAttribute('aria-label') ?? ''} ${button.getAttribute('title') ?? ''} ${button.textContent ?? ''}`
    .toLowerCase()
    .replace(/\s+/g, ' ')
  return NEW_SESSION_LABELS.some((label) => name.includes(label))
}

/** Find the sidebar shell root, or undefined while it is not mounted. */
function sidebarRoot(): HTMLElement | undefined {
  const column = document.querySelector<HTMLElement>(SIDEBAR_COLUMN_SELECTOR)
  const logoRow = (column ?? document).querySelector<HTMLElement>('[class*="logoRow"]')
  if (logoRow !== null) {
    // Walk out of the brand row until an ancestor also owns the shell button:
    // desktop shells put a wrapper surface between the two, so the row parent is
    // not always the root the tabs have to live in (#20).
    for (let candidate = logoRow.parentElement; candidate !== null; candidate = candidate.parentElement) {
      if (candidate === document.body) break
      if (newSessionButton(candidate, false) !== undefined) return candidate
      if (candidate === column) break
      if (column !== null && !column.contains(candidate)) break
    }
    // Legacy shape: with no recognisable shell button anywhere above the brand
    // row its parent stays the mount point, which is where the web shell has
    // always kept the tabs (#20).
    return logoRow.parentElement ?? column ?? undefined
  }
  if (column === null) return undefined
  return (column.firstElementChild as HTMLElement | undefined) ?? column
}

/**
 * The shell-owned New Session button across current and legacy shells. The
 * loose fallback stays opt-in so the root search never settles on a wrapper
 * whose first button happens to be a brand or collapse toggle (#20).
 */
function newSessionButton(root: HTMLElement, allowLooseFallback = true): HTMLButtonElement | undefined {
  const hooked = root.querySelector<HTMLButtonElement>(
    'button[data-dsh-part="new-session"], button[class*="newSession"]',
  )
  if (hooked !== null) return hooked
  const labelled = Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find(looksLikeNewSession)
  if (labelled !== undefined) return labelled
  if (!allowLooseFallback) return undefined
  return Array.from(root.children).find(
    (child): child is HTMLButtonElement => child instanceof HTMLElement && child.tagName === 'BUTTON',
  )
}

/** Locate the shell region that normally contains workspaces and sessions. */
function regionArea(root: HTMLElement): HTMLElement | undefined {
  return root.querySelector<HTMLElement>('[class*="regionArea"]') ?? undefined
}

function makeTab(
  label: string,
  tooltip: string,
  icon: string,
  onClick: () => void,
): HTMLButtonElement {
  const tab = document.createElement('button')
  tab.type = 'button'
  tab.className = css.sessionTab
  tab.setAttribute('aria-label', label)
  tab.setAttribute('title', tooltip)
  tab.innerHTML = `<span class="${css.sessionTabIcon}">${icon}</span><span class="${css.sessionTabLabel}">${label}</span>`
  tab.addEventListener('click', onClick)
  return tab
}

/**
 * Mount or repair the two-tab switcher directly above the shell's New Session
 * button, which stays visible: the switcher only moves between the conversation
 * and the studio, it never creates a session.
 */
function placeTabs(
  root: HTMLElement,
  controller: ImageGenController,
  sessionLabel: string,
  sessionTooltip: string,
  imageLabel: string,
  imageTooltip: string,
): HTMLDivElement | undefined {
  const button = newSessionButton(root)
  if (button === undefined) return undefined

  const existing = root.querySelector<HTMLDivElement>(ENTRY_SELECTOR)
  if (existing !== null && existing.parentElement === button.parentElement) return existing

  if (existing !== null && button.parentElement !== null) {
    // Move the settled entry instead of rebuilding it: a rebuild re-binds the
    // click handlers and writes fresh nodes on every shell re-render, which is
    // what kept the mutation observer busy.
    button.parentElement.insertBefore(existing, button)
    return existing
  }
  const tabs = document.createElement('div')
  // Attribute names are written verbatim: dataset camelCase would produce
  // `data-dsh-imagegen-session-tabs` and never match ENTRY_SELECTOR, so every
  // repair pass used to insert one more copy of the switcher.
  tabs.setAttribute('data-dsh-imagegen-studio-session-tabs', '')
  tabs.className = css.sessionTabs
  tabs.setAttribute('role', 'tablist')
  tabs.setAttribute('aria-label', imageTooltip)

  const sessionTab = makeTab(sessionLabel, sessionTooltip, SESSION_ICON, () => {
    controller.close()
  })
  const imageTab = makeTab(imageLabel, imageTooltip, IMAGE_ICON, () => {
    controller.open()
  })
  sessionTab.setAttribute('data-dsh-imagegen-studio-tab', 'session')
  imageTab.setAttribute('data-dsh-imagegen-studio-tab', 'image')
  tabs.append(sessionTab, imageTab)

  // The shell button keeps its own slot below the switcher, untouched.
  button.parentElement?.insertBefore(tabs, button)
  return tabs
}

/**
 * Regions that keep evicting the host are React-owned lists: re-adding the node
 * on every repair pass turns into an insert/remove war that starves the
 * renderer (no paint, no CDP, the GUI looks frozen). A couple of attempts tells
 * a one-off re-render from a reconcile loop; after that the history surface
 * stays unavailable and the shell keeps its own tree.
 */
const historyRepairs = new WeakMap<HTMLElement, number>()
const HISTORY_REPAIR_LIMIT = 2

/** Mount an overlay host over the workspace/session tree for image history. */
function placeHistoryHost(root: HTMLElement): HTMLDivElement | undefined {
  const region = regionArea(root)
  if (region === undefined) return undefined
  const existing = region.querySelector<HTMLDivElement>(HISTORY_HOST_SELECTOR)
  if (existing !== null) return existing
  const repairs = historyRepairs.get(region) ?? 0
  if (repairs >= HISTORY_REPAIR_LIMIT) {
    if (repairs === HISTORY_REPAIR_LIMIT) {
      historyRepairs.set(region, repairs + 1)
      console.warn(
        '[dsh-imagegen-studio] image history surface unavailable: the shell removes the injected host on every render',
      )
    }
    return undefined
  }
  historyRepairs.set(region, repairs + 1)
  const host = document.createElement('div')
  host.setAttribute('data-dsh-imagegen-studio-history-host', '')
  host.className = css.sidebarHistoryHost
  region.append(host)
  return host
}

/**
 * Keep exactly one copy of an injected node across the whole document.
 *
 * Desktop shells mount the sidebar more than once (upstream sidebar surface,
 * desktop sidebar surface, and a mobile drawer can all be connected at the same
 * time), and a re-render can clone the subtree that already holds our host. The
 * React portal only owns the node it was created against, so every other copy
 * is dead markup that shows up as the same panel repeated side by side. The
 * first connected node wins; the rest are removed.
 */
function pruneDuplicates(selector: string, keep: HTMLElement | undefined): void {
  if (keep === undefined) return
  for (const node of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
    if (node !== keep) node.remove()
  }
}

/**
 * Mount the two tabs and self-heal after React rebuilds the sidebar. The
 * shell-owned New Session button keeps its native behavior. A temporary marker
 * preserves its visibility and identifies context clicks across shell layouts.
 */
export function mountSidebarEntry(
  controller: ImageGenController,
  sessionLabel: string,
  sessionTooltip: string,
  imageLabel: string,
  imageTooltip: string,
): () => void {
  let root: HTMLElement | undefined
  let tabs: HTMLDivElement | undefined
  let historyHost: HTMLDivElement | undefined
  let markedButton: HTMLButtonElement | undefined
  let warnedUnmounted = false

  /**
   * Compact shell fingerprint for the warning below: it never dumps the sidebar
   * markup (which carries session titles), only the markers we look for.
   */
  const describeShell = (): string => {
    const markers = SIDEBAR_COLUMN_SELECTOR.split(', ')
      .map((selector) => `${selector}=${document.querySelectorAll(selector).length}`)
      .join(' ')
    const outline = Array.from(document.body.children)
      .slice(0, 6)
      .map((element) => {
        const name = typeof element.className === 'string' ? element.className.split(/\s+/)[0] : ''
        return `${element.tagName.toLowerCase()}${name === '' ? '' : `.${name}`}`
      })
      .join(' > ')
    return `${markers} body>${outline}`
  }

  // A shell we have never seen must not fail silently: the reporter of #20 had
  // no console output at all to work from.
  const warnUnmounted = (): void => {
    if (warnedUnmounted || tabs !== undefined) return
    warnedUnmounted = true
    const reason = root === undefined ? 'sidebar root not found' : 'new-session button not found'
    console.warn(`[dsh-imagegen-studio] sidebar entry stayed unmounted (${reason}); shell probe: ${describeShell()}`)
  }

  const unmountedTimer = window.setTimeout(warnUnmounted, 5000)

  const syncActive = (): void => {
    if (tabs === undefined) return
    const sessionTab = tabs.querySelector<HTMLElement>('[data-dsh-imagegen-studio-tab="session"]')
    const imageTab = tabs.querySelector<HTMLElement>('[data-dsh-imagegen-studio-tab="image"]')
    if (controller.getSnapshot().panelOpen) {
      if (sessionTab !== null) delete sessionTab.dataset.active
      if (imageTab !== null) imageTab.dataset.active = ''
    } else {
      if (sessionTab !== null) sessionTab.dataset.active = ''
      if (imageTab !== null) delete imageTab.dataset.active
    }
  }

  const ensureNow = (): void => {
    if (root !== undefined && !root.isConnected) {
      markedButton?.removeAttribute('data-dsh-imagegen-studio-new-session')
      markedButton = undefined
      root = undefined
      tabs = undefined
      historyHost = undefined
    }
    root ??= sidebarRoot()
    if (root === undefined) return
    // Attribute writes are cheap but still avoidable on the hot path: the
    // observer fires for every shell mutation, so a settled sidebar must cost
    // zero writes.
    if (!root.hasAttribute('data-dsh-imagegen-studio-sidebar-root')) {
      root.setAttribute('data-dsh-imagegen-studio-sidebar-root', '')
    }
    const button = newSessionButton(root)
    if (button === undefined) return
    if (markedButton !== button) markedButton?.removeAttribute('data-dsh-imagegen-studio-new-session')
    markedButton = button
    if (!button.hasAttribute('data-dsh-imagegen-studio-new-session')) {
      button.setAttribute('data-dsh-imagegen-studio-new-session', '')
    }
    tabs = placeTabs(root, controller, sessionLabel, sessionTooltip, imageLabel, imageTooltip)
    historyHost = placeHistoryHost(root)
    // A cloned sidebar subtree brings a second copy of both injections with it;
    // drop everything but the node the React portal and click handlers own.
    pruneDuplicates(HISTORY_HOST_SELECTOR, historyHost)
    pruneDuplicates(ENTRY_SELECTOR, tabs)
    syncActive()
  }

  // A whole-document observer that writes to the DOM from its own callback is a
  // feedback loop waiting to happen: the insertion of the tabs is itself a
  // childList mutation, and on a shell that rebuilds the sidebar row (DSH
  // Desktop swaps the upstream sidebar surface while booting) every pass found
  // a new button, migrated the tabs, and mutated again - the renderer never
  // returned to the event loop and the GUI froze on "正在读取本地工作台".
  //
  // Three rules keep the self-heal safe:
  //   1. the observer only ever schedules work; it never writes from the
  //      callback, so a pass can never re-enter itself synchronously;
  //   2. records queued by our own writes are dropped before delivery, so a
  //      settled sidebar produces no further passes;
  //   3. a rate watchdog disconnects the observer if a hostile shell still
  //      manages to keep it busy, trading self-healing for a usable GUI.
  let scheduled = false
  let applying = false
  let passes = 0
  let windowStart = 0

  const runEnsure = (): void => {
    if (applying) return
    applying = true
    const now = Date.now()
    if (now - windowStart > 1000) {
      windowStart = now
      passes = 0
    }
    passes += 1
    if (passes > 40) {
      bodyObserver.disconnect()
      applying = false
      console.warn(
        '[dsh-imagegen-studio] sidebar self-heal paused: the shell rewrote its sidebar faster than the entry could settle',
      )
      return
    }
    try {
      ensureNow()
    } catch (error) {
      console.warn('[dsh-imagegen-studio] sidebar entry repair failed:', error)
    } finally {
      applying = false
      bodyObserver.takeRecords()
    }
  }

  const scheduleEnsure = (): void => {
    if (scheduled) return
    scheduled = true
    // A macrotask, not a microtask: if a shell ever does fight the injection,
    // the repair loop still yields between passes and the renderer keeps
    // painting instead of starving every task behind it.
    window.setTimeout(() => {
      scheduled = false
      if (applying) return
      runEnsure()
    }, 0)
  }

  const bodyObserver = new MutationObserver(scheduleEnsure)
  bodyObserver.observe(document.body, { childList: true, subtree: true })
  const unsubscribe = controller.subscribe(syncActive)
  runEnsure()

  return () => {
    window.clearTimeout(unmountedTimer)
    bodyObserver.disconnect()
    unsubscribe()
    tabs?.remove()
    historyHost?.remove()
    markedButton?.removeAttribute('data-dsh-imagegen-studio-new-session')
    if (root !== undefined) root.removeAttribute('data-dsh-imagegen-studio-sidebar-root')
  }
}

/**
 * Internals re-exported for the standalone smoke test: the browser bundle is
 * the only consumer of the entry, so the check has to drive these directly to
 * cover a shell layout the jsdom studio fixture does not render (#20).
 */
export const sidebarEntryTestHooks = {
  findSidebarRoot: sidebarRoot,
  findNewSessionButton: newSessionButton,
  mount: mountSidebarEntry,
}
