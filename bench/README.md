# Benchmarks: Pane, Tauri and Electron

Five small apps (Notes, Kanban, Markdown, Timer, Dashboard), each built three ways from the same HTML, CSS and JavaScript:

- **Pane:** installed with `pane install`. All five share one copy of Pane.
- **Tauri:** a Tauri 2 release build (`cargo build --release`, Tauri's own release settings). It uses macOS's built-in WebKit.
- **Electron:** a plain Electron app, the way Electron apps ship. Each app has its own copy of Electron.app (the same Electron version Pane uses), with the app in `Resources/app`, signed ad hoc.

Results: [RESULTS.md](RESULTS.md).

## How it was measured

1. Open 1, 3 or 5 of the apps, 1.5 s apart.
2. Wait 15 s for them to settle.
3. **Memory:** macOS's `footprint` tool over every process the apps started, with memory shared between processes counted once. This is the figure Activity Monitor shows as "Memory", not RSS. Tauri's web content runs in WebKit system services (`com.apple.WebKit.*`), not in child processes of the app, so new WebKit processes are counted too.
4. **CPU:** the CPU time all those processes used over the next 10 s, as a percentage of one core. The Timer app animates and the Dashboard redraws four charts every second; the others sit idle.
5. Close the apps by their process ids.

Every case runs 3 times, and the tables show the median. The order of Pane, Tauri and Electron rotates between runs, so no runtime always goes first.

To run it yourself (macOS, with Rust installed for Tauri):

```sh
node bench/build.js     # builds all 15 apps into bench/out (Pane apps go into a sandboxed PANE_HOME)
node bench/run.js       # opens real windows for about 15 minutes, then writes RESULTS.md
```

## What these numbers don't show

- **One computer.** Everything was measured on one Mac, with the usual background apps running. Expect a few MB of noise between runs. On Windows, Tauri uses WebView2 (Chromium), so the comparison there will look different.
- **No backends.** The apps are pages only. Pane's and Electron's Node backend and Tauri's Rust commands are not exercised.
- **The five apps differ.** Opening "5 apps" adds the Timer (animating) and the Dashboard (redrawing charts) to three idle apps. So "each extra app" averages different apps, and the CPU jump at 5 apps comes from those two.
- **Small, quiet apps.** Real apps with large pages, many windows or heavy JavaScript use more memory, and in different proportions.
- **Not measured:** startup time, memory growth over hours, GPU memory, and battery use.
- **Pane's first install** downloads Pane itself once (Chromium and Node). The size table shows that cost separately. After that, each Pane app is a few kilobytes.
- **Tauri apps were run as release binaries,** not as bundled .app files. The difference in memory is negligible, and an .app adds only icons and a plist to the size.

## Better ways to benchmark (not done yet)

- **Startup time:** have each page report when it first painted, and measure launch to first paint.
- **Clean machines:** run the same scripts on GitHub's macOS and Windows runners, so anyone can reproduce the numbers and Windows (WebView2) is covered.
- **A long run:** keep the apps open for 30 minutes while they work (typing, scrolling, charts), and record memory every minute.
- **Energy:** macOS `powermetrics` (needs admin rights), which measures what users notice as battery drain.
- **Backends:** a version of each app that does real work in its backend (files, a small database).
