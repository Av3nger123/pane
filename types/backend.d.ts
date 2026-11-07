// The `pane` module for app backends. Kept in its own file without imports or
// exports, so `declare module 'pane'` declares the module (not augments it).

declare module 'pane' {
  interface PaneBackendAppInfo {
    readonly id: string;
    readonly name: string;
    readonly version: string;
    /** The installed app's folder. Treat it as read-only. */
    readonly dir: string;
    /** A private folder for this app's files. Survives app updates. */
    readonly dataDir: string;
    readonly dev: boolean;
  }

  type Handler = (...args: any[]) => unknown;

  interface PaneBackendApi {
    readonly app: PaneBackendAppInfo;
    /** Makes functions callable from pages with pane.call(name, ...args). */
    expose(name: string, fn: Handler): void;
    expose(functions: Record<string, Handler>): void;
    /** Listens for events pages send with pane.send(). Returns a function that stops listening. */
    on<T = unknown>(event: string, listener: (data: T) => void | Promise<void>): () => void;
    /** Sends an event to every window of this app. */
    emit(event: string, data?: unknown): void;
  }

  const pane: PaneBackendApi;
  export = pane;
}
