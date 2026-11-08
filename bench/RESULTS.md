# Benchmark results

Measured 2026-11-08 on Apple M4, 16 GB RAM, macOS 26.5.1.
Pane 0.1.0 and plain Electron 45.2.3 (the same Electron), Tauri 2.12.5 (macOS WebKit).
Median of 3 runs per cell. How these were measured, and what they leave out: [README.md](README.md).

## Memory (all processes the apps started, shared memory counted once)

| | 1 app | 3 apps | 5 apps | Each extra app (5 vs 1) |
|---|---|---|---|---|
| Pane | 100 MB | 313 MB | 663 MB | 141 MB |
| Tauri | 78 MB | 240 MB | 547 MB | 117 MB |
| Electron | 96 MB | 294 MB | 643 MB | 137 MB |

## CPU while open (average over 10 s, % of one core)

| | 1 app | 3 apps | 5 apps |
|---|---|---|---|
| Pane | 0.0% | 0.1% | 23.0% |
| Tauri | 0.1% | 0.0% | 28.1% |
| Electron | 0.0% | 0.1% | 21.2% |

## Processes

| | 1 app | 3 apps | 5 apps |
|---|---|---|---|
| Pane | 4 | 12 | 20 |
| Tauri | 4 | 12 | 20 |
| Electron | 4 | 12 | 20 |

## Size

| | Each app on disk | Each app download | Shared, once per computer |
|---|---|---|---|
| Pane | 3 KB | 3 KB or less (.paneapp) | 258 MB (Pane: Chromium, Node, Pane) |
| Tauri | 3.1 MB | ~1.4 MB compressed | none (uses macOS WebKit) |
| Electron | 252 MB | ~114 MB zipped | none (each app ships its own) |
