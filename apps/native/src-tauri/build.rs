fn main() {
    // `set_zoom` is the one app command, and it is declared here so it gets a
    // permission of its own (`allow-set-zoom`). The sidecar's page is a
    // *remote* origin to Tauri, and capabilities/sidecar.json grants that
    // origin exactly this permission — nothing else of the IPC.
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["set_zoom"])),
    )
    .expect("failed to run tauri-build");
}
