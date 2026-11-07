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
  }

  interface Window {
    readonly pane: PaneBridge;
  }
  const pane: PaneBridge;
}
