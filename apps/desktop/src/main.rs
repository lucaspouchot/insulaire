//! The desktop shell: a native window that hosts the game bundle.
//!
//! # What this binary is, and what it is not
//!
//! It is not a second implementation of the game. The Angular application and
//! the WebAssembly engine are exactly the ones the browser build produces —
//! `tauri.conf.json` points `frontendDist` at the `deliver` build, so the shell
//! ships the game without the editor, by the same file replacement ADR-0015
//! describes. The engine keeps running as WASM inside the webview: the
//! Angular/engine boundary that is tested and documented stays the only one
//! (`docs/adr/ADR-0017-desktop-executable.md`).
//!
//! So this file owns three things, and nothing else: the window, the assets
//! embedded in the executable, and the native services a browser cannot give —
//! today, the Steam seam in [`steam`].

// A game is not a console application: on Windows, do not open a terminal
// behind the window. Debug builds keep it, because that is where a panic and
// anything written to stdout show up.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod steam;

fn main() {
    // Started before the window: the real Steamworks client wants to be
    // initialised early, and a failure here is never fatal — a build launched
    // outside Steam is a legitimate way to run the game.
    let steam = steam::Steam::start();
    println!("[insulaire] steam: {}", steam.describe());

    tauri::Builder::default()
        .manage(steam)
        .run(tauri::generate_context!())
        .expect("the desktop shell failed to start");
}
