fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "desktop_status",
            "desktop_retry",
            "desktop_quit",
            "desktop_import",
        ]),
    ))
    .expect("Tauri build configuration");
}
