// Types for Pane apps.
//
// Pages get a global `pane`. Backends `import pane from 'pane'` (or require it).
// Add this package to "types" in tsconfig.json / jsconfig.json.
//
// Typed backend calls: describe your backend's exposed functions once and
// pane.call checks names, arguments and return types.
//
//   declare global {
//     interface PaneBackend {
//       greet(who: string): string;
//       save(note: { title: string }): Promise<number>;
//     }
//   }
//   const id = await pane.call('save', { title: 'x' });   // id: number

/// <reference path="./backend.d.ts" />

export {};

declare global {
  /** Augment with your backend's exposed functions to type `pane.call`. */
  interface PaneBackend {}

  /** Augment with your backend's events to type `pane.on`. */
  interface PaneEvents {
    /** The backend process stopped. In installed apps Pane restarts it a few times. */
    'pane:backend-exit': { code: number; willRestart: boolean; log?: string[] };
    /** The backend was started again. */
    'pane:backend-restart': null;
    /** An app menu item (pane.menu.set) was clicked in this window. */
    'pane:menu': { id: string };
    /** A notification from pane.notify was clicked. */
    'pane:notification-click': { id: string | null };
  }

  interface PaneMenuItem {
    label?: string;
    /** Reported in 'pane:menu' events and returned by pane.menu.popup. Required unless the item has `items`. */
    id?: string;
    /** e.g. "CmdOrCtrl+N", "CmdOrCtrl+Shift+E", "F5" */
    shortcut?: string;
    enabled?: boolean;
    /** Makes it a checkbox item. */
    checked?: boolean;
    items?: PaneMenuItem[];
    type?: 'separator';
  }

  interface PaneFileFilter {
    name: string;
    extensions: string[];
  }

  interface PaneDialogApi {
    /** The paths the user picked, or [] if cancelled. */
    open(options?: { title?: string; defaultPath?: string; buttonLabel?: string; filters?: PaneFileFilter[]; multiple?: boolean; directory?: boolean; showHidden?: boolean }): Promise<string[]>;
    /** The path to save to, or null if cancelled. Pages cannot write files: pass the path to the backend. */
    save(options?: { title?: string; defaultPath?: string; buttonLabel?: string; filters?: PaneFileFilter[] }): Promise<string | null>;
    /** The index of the button pressed. */
    message(options: { message: string; detail?: string; type?: 'none' | 'info' | 'warning' | 'error' | 'question'; buttons?: string[]; defaultId?: number; cancelId?: number; title?: string }): Promise<number>;
    /** true if the user pressed the OK button. */
    confirm(message: string, options?: { detail?: string; okLabel?: string; cancelLabel?: string; type?: 'none' | 'info' | 'warning' | 'error' | 'question' }): Promise<boolean>;
  }

  interface PaneMenuApi {
    /** Sets the app's menus. Items in "File", "Edit", "View", "Window" or "Help" merge into Pane's standard menus. */
    set(menus: Array<{ label: string; items: PaneMenuItem[] }>): Promise<boolean>;
    /** Shows a context menu at the pointer (or at x, y). Resolves to the clicked item's id, or null. */
    popup(items: PaneMenuItem[], at?: { x?: number; y?: number }): Promise<string | null>;
  }

  type PaneJson = string | number | boolean | null | PaneJson[] | { [key: string]: PaneJson };

  interface PaneStoreApi {
    get<T extends PaneJson = PaneJson>(key: string): Promise<T | undefined>;
    set(key: string, value: PaneJson): Promise<boolean>;
    delete(key: string): Promise<boolean>;
    all(): Promise<Record<string, PaneJson>>;
  }

  interface PaneSecretsApi {
    /** null if there is no secret with this key. */
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<boolean>;
    delete(key: string): Promise<boolean>;
  }

  interface PaneAppInfo {
    readonly id: string;
    readonly name: string;
    readonly version: string;
    /** Running under `pane dev`. */
    readonly dev: boolean;
    readonly hasBackend: boolean;
    /** Version of the Pane runtime. */
    readonly pane: string;
  }

  interface PaneWindowOptions {
    width?: number;
    height?: number;
    title?: string;
    /** Windows with a key remember their size and position; opening the same key again focuses the open window. */
    key?: string;
  }

  interface PaneWindowApi {
    readonly id: number;
    readonly isMain: boolean;
    /** Opens another window of this app. `page` is a file in the ui folder, optionally with #hash or ?query. */
    open(page: string, options?: PaneWindowOptions): Promise<number>;
    close(): Promise<boolean>;
    minimize(): Promise<boolean>;
    /** Returns true if the window is now maximized. */
    toggleMaximize(): Promise<boolean>;
    toggleFullScreen(): Promise<boolean>;
    setTitle(title: string): Promise<boolean>;
    focus(): Promise<boolean>;
  }

  type PaneFn = (...args: any[]) => unknown;
  type PaneMethod = { [K in keyof PaneBackend]: PaneBackend[K] extends PaneFn ? K : never }[keyof PaneBackend];

  interface PaneBridge {
    readonly app: PaneAppInfo;
    /** Calls a function the backend exposed with pane.expose(). */
    call<K extends PaneMethod>(
      method: K,
      ...args: PaneBackend[K] extends PaneFn ? Parameters<PaneBackend[K]> : never
    ): Promise<PaneBackend[K] extends PaneFn ? Awaited<ReturnType<PaneBackend[K]>> : never>;
    /** Any other backend function. Names declared in PaneBackend must use the typed form above. */
    call<T = unknown, M extends string = string>(method: M & (M extends PaneMethod ? never : unknown), ...args: unknown[]): Promise<T>;
    /** Sends an event to the backend (pane.on in the backend). No answer. */
    send(event: string, data?: unknown): void;
    /** Listens for backend events. Returns a function that stops listening. */
    on<K extends keyof PaneEvents>(event: K, listener: (data: PaneEvents[K]) => void): () => void;
    on(event: '*', listener: (event: string, data: unknown) => void): () => void;
    on<T = unknown>(event: string, listener: (data: T) => void): () => void;
    readonly window: PaneWindowApi;
    /** Opens an http(s) or mailto link in the user's browser or mail app. */
    openExternal(url: string): Promise<boolean>;
    /**
     * Links (pane.json "protocols") and files ("fileTypes") the system opened this app with.
     * The first call also receives anything that arrived before the page loaded.
     * Treat URLs and file contents as untrusted input. Returns a function that stops listening.
     */
    onOpen(listener: (request: { kind: 'url'; url: string } | { kind: 'file'; path: string }) => void): () => void;
    /** The path of a File from drag and drop or <input type="file">, to pass to the backend. */
    pathForFile(file: File): string;
    readonly dialog: PaneDialogApi;
    readonly menu: PaneMenuApi;
    readonly shell: { showItemInFolder(fullPath: string): Promise<boolean> };
    /** A system notification. Needs "notifications" in pane.json's permissions. Returns false where unsupported. */
    notify(options: { title: string; body?: string; silent?: boolean; id?: string }): Promise<boolean>;
    /** Small JSON settings kept by Pane for this app (up to 1 MB). */
    readonly store: PaneStoreApi;
    /** Text encrypted with the system keychain. */
    readonly secrets: PaneSecretsApi;
  }

  interface Window {
    readonly pane: PaneBridge;
  }
  const pane: PaneBridge;
}
