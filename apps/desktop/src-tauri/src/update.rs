//! Mise à jour de l'application autonome, depuis les releases GitHub.
//!
//! Au lancement, hors du fil de la fenêtre, la coque demande au dépôt s'il
//! existe une version plus récente (`latest.json`, publié avec chaque
//! release). S'il y en a une, **elle demande** : un dialogue natif dit la
//! version et ses notes, et rien ne s'installe sans un « Installer ».
//!
//! Quatre règles, chacune pour une raison :
//!
//!  - **une mise à jour est signée, et sa signature porte sa version.** Le
//!    manifeste voyage en TLS mais n'est pas signé ; le paquet, lui, l'est
//!    (minisign), contre la clé publique gravée dans la configuration, et
//!    `requireSignedVersion` refuse un paquet authentique mais plus ancien
//!    qu'un manifeste falsifié présenterait comme nouveau. La vérification est
//!    celle du plugin de Tauri (`tauri-plugin-updater`) : on ne réécrit pas de
//!    cryptographie ici ;
//!  - **jamais pendant qu'une tâche est active.** Avant d'installer, la coque
//!    demande au daemon de s'arrêter *s'il est oisif* (`harness stop
//!    --if-idle`) : c'est lui qui décide, et un daemon qui travaille reporte
//!    la mise à jour au lieu d'être interrompu. L'arrêt est aussi une
//!    nécessité : un installeur ne remplace pas un Node encore en marche ;
//!  - **rien n'est accordé à la page.** Le dialogue est ouvert par la coque,
//!    en Rust ; le dashboard ne reçoit toujours aucune capacité Tauri et ne
//!    peut ni vérifier, ni télécharger, ni installer ;
//!  - **seule une application autonome se met à jour.** La coque lancée d'un
//!    clone (`npm run desktop`) suit son clone : c'est `git pull` qui la met à
//!    jour.
//!
//! Deux formes d'application, deux installations :
//!
//!  - **le bundle** (`.app` sous macOS, installeur NSIS sous Windows, `.deb`)
//!    est remplacé par le plugin, comme toute application Tauri ;
//!  - **l'exécutable unique** (`--features portable`) n'a pas d'installeur :
//!    il télécharge le nouvel exécutable — sous sa propre cible du manifeste,
//!    `<os>-<arch>-portable` —, le vérifie par le même plugin, puis **se
//!    remplace lui-même** ([`replace_executable`]).
//!
//! `MIDGAARD_NO_UPDATE=1` désactive toute vérification (tests, postes sans
//! réseau). Une vérification qui échoue — pas de réseau, aucune release — ne
//! dit rien : ce n'est pas une panne de l'application.

use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Où lire les releases quand la mise à jour ne peut pas s'installer seule.
const RELEASES_PAGE: &str = "https://github.com/AndyD9/Midgaard-Neo/releases/latest";
/// Taille des notes de version montrées dans le dialogue : il doit tenir à l'écran.
const NOTES_MAX_CHARS: usize = 600;
/// Code de sortie de `harness stop --if-idle` quand le daemon travaille.
const EXIT_BUSY: i32 = 3;

/// De quoi relancer la CLI embarquée : le Node et le point d'entrée de
/// l'application autonome en cours.
pub struct Cli {
    pub node: PathBuf,
    pub cli: PathBuf,
}

/// Lance la vérification, hors du fil de la fenêtre. Ne bloque rien : la
/// fenêtre est déjà ouverte, et l'utilisateur travaille pendant ce temps.
pub fn spawn(app: AppHandle, cli: Cli) {
    if std::env::var("MIDGAARD_NO_UPDATE").is_ok_and(|v| !v.is_empty() && v != "0") {
        return;
    }
    cleanup_previous();
    std::thread::spawn(move || {
        if let Err(e) = run(&app, &cli) {
            // Sans terminal, personne ne lit ceci ; avec, c'est le seul indice.
            eprintln!("midgaard : mise à jour : {e}");
        }
    });
}

/// Vérifie, demande, puis installe. Une erreur **avant** l'accord de
/// l'utilisateur remonte en silence ; après, elle lui est montrée.
fn run(app: &AppHandle, cli: &Cli) -> Result<(), String> {
    let mut builder = app.updater_builder();
    if cfg!(feature = "portable") {
        builder = builder.target(portable_target());
    }
    let updater = builder.build().map_err(|e| e.to_string())?;
    let Some(update) = tauri::async_runtime::block_on(updater.check()).map_err(|e| e.to_string())? else {
        return Ok(());
    };

    let question = format!(
        "Midgaard {} est disponible (vous utilisez la version {}).{}\n\nInstaller maintenant ? L'application redémarrera.",
        update.version,
        update.current_version,
        notes_excerpt(update.body.as_deref()).map(|n| format!("\n\n{n}")).unwrap_or_default(),
    );
    let accepted = app
        .dialog()
        .message(question)
        .title("Mise à jour de Midgaard")
        .buttons(MessageDialogButtons::OkCancelCustom("Installer".into(), "Plus tard".into()))
        .blocking_show();
    if !accepted {
        return Ok(());
    }

    match stop_daemon_if_idle(cli) {
        Ok(true) => {}
        Ok(false) => {
            tell(
                app,
                MessageDialogKind::Info,
                "Des tâches sont en cours : la mise à jour est reportée pour ne pas les interrompre.\n\n\
                 Relancez Midgaard quand elles sont terminées : la mise à jour vous sera proposée de nouveau.",
            );
            return Ok(());
        }
        Err(e) => {
            tell(app, MessageDialogKind::Error, &failure(&format!("le daemon n'a pas pu être arrêté ({e})")));
            return Err(e);
        }
    }

    if let Err(e) = install(app, &update) {
        tell(app, MessageDialogKind::Error, &failure(&e));
        return Err(e);
    }
    Ok(())
}

/// Télécharge, vérifie, installe, puis relance l'application.
fn install(app: &AppHandle, update: &Update) -> Result<(), String> {
    // `download` vérifie la signature avant de rendre les octets.
    let bytes = tauri::async_runtime::block_on(update.download(|_, _| {}, || {})).map_err(|e| e.to_string())?;

    if cfg!(feature = "portable") {
        let exe = std::env::current_exe().map_err(|e| format!("exécutable introuvable ({e})"))?;
        replace_executable(&exe, &bytes)?;
        // Relancé par son chemin, et non par `restart()` : sous Windows,
        // l'exécutable en marche vient d'être renommé, et c'est le nouveau
        // fichier, à l'ancien chemin, qu'il faut lancer.
        Command::new(&exe).spawn().map_err(|e| format!("mise à jour installée, mais relance impossible ({e})"))?;
        app.exit(0);
        return Ok(());
    }

    // Le bundle : sous Windows, le plugin lance l'installeur et quitte
    // l'application lui-même ; ailleurs, il remplace le bundle et rend la main.
    update.install(&bytes).map_err(|e| e.to_string())?;
    app.restart()
}

/// Demande au daemon de s'arrêter s'il n'a aucune tâche active.
///
/// @returns vrai si plus aucun daemon ne tourne, faux s'il travaille
fn stop_daemon_if_idle(cli: &Cli) -> Result<bool, String> {
    let mut command = Command::new(&cli.node);
    command.arg(&cli.cli).args(["stop", "--if-idle"]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let output = command.output().map_err(|e| format!("impossible de lancer Node ({e})"))?;
    match output.status.code() {
        Some(0) => Ok(true),
        Some(EXIT_BUSY) => Ok(false),
        _ => Err(String::from_utf8_lossy(&output.stdout).trim().to_owned()),
    }
}

/// Un dialogue d'information, sans choix.
fn tell(app: &AppHandle, kind: MessageDialogKind, message: &str) {
    app.dialog().message(message).title("Mise à jour de Midgaard").kind(kind).blocking_show();
}

/// Le message d'une installation manquée : ce qui s'est passé, et où trouver
/// la version à la main. L'application en cours n'a pas été touchée, ou a été
/// remise en place.
fn failure(cause: &str) -> String {
    format!("La mise à jour n'a pas pu être installée : {cause}.\n\nVous pouvez la télécharger vous-même : {RELEASES_PAGE}")
}

/// La cible de l'exécutable unique dans le manifeste : `<os>-<arch>-portable`,
/// avec les noms d'OS et d'architecture du plugin.
pub fn portable_target() -> String {
    format!("{}-portable", tauri_plugin_updater::target().unwrap_or_else(|| "unknown".to_owned()))
}

/// Les notes de version, prêtes pour un dialogue : sans caractère de
/// contrôle, et coupées à [`NOTES_MAX_CHARS`]. Le texte vient du manifeste,
/// qui n'est pas signé : il est montré comme du texte, jamais interprété.
pub fn notes_excerpt(body: Option<&str>) -> Option<String> {
    let clean: String = body?.chars().filter(|c| *c == '\n' || !c.is_control()).collect();
    let clean = clean.trim();
    if clean.is_empty() {
        return None;
    }
    if clean.chars().count() <= NOTES_MAX_CHARS {
        return Some(clean.to_owned());
    }
    Some(format!("{}…", clean.chars().take(NOTES_MAX_CHARS).collect::<String>().trim_end()))
}

/// Le chemin où l'exécutable remplacé est mis de côté.
fn previous_path(exe: &Path) -> PathBuf {
    let mut name = exe.file_name().unwrap_or_default().to_os_string();
    name.push(".old");
    exe.with_file_name(name)
}

/// Remplace l'exécutable unique par `bytes`, **entier ou pas du tout**.
///
/// Le nouveau fichier est écrit à côté, puis mis en place par renommages :
/// l'ancien passe sous `<nom>.old` (Windows interdit d'écraser un exécutable
/// en marche, mais permet de le renommer), le nouveau prend son nom. Si la
/// mise en place échoue, l'ancien est remis : on ne laisse jamais
/// l'utilisateur sans exécutable. L'ancien est retiré au lancement suivant
/// ([`cleanup_previous`]).
pub fn replace_executable(exe: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut name = exe.file_name().ok_or("exécutable sans nom")?.to_os_string();
    name.push(".new");
    let staged = exe.with_file_name(name);
    let fail = |what: &str, e: std::io::Error| format!("{what} dans {} ({e})", exe.parent().unwrap_or(exe).display());

    std::fs::write(&staged, bytes).map_err(|e| fail("écriture impossible", e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Err(e) = std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o755)) {
            let _ = std::fs::remove_file(&staged);
            return Err(fail("droits d'exécution refusés", e));
        }
    }
    let previous = previous_path(exe);
    let _ = std::fs::remove_file(&previous);
    if let Err(e) = std::fs::rename(exe, &previous) {
        let _ = std::fs::remove_file(&staged);
        return Err(fail("l'exécutable en place ne se déplace pas", e));
    }
    if let Err(e) = std::fs::rename(&staged, exe) {
        let _ = std::fs::rename(&previous, exe);
        let _ = std::fs::remove_file(&staged);
        return Err(fail("le nouvel exécutable ne se met pas en place", e));
    }
    Ok(())
}

/// Retire l'exécutable mis de côté par une mise à jour précédente. Sous
/// Windows, il ne pouvait pas l'être tant qu'il tournait.
fn cleanup_previous() {
    if cfg!(feature = "portable") {
        if let Ok(exe) = std::env::current_exe() {
            let _ = std::fs::remove_file(previous_path(&exe));
        }
    }
}

#[cfg(test)]
mod tests {
    //! Ce qui se prouve sans réseau : la cible de l'exécutable unique, les
    //! notes montrées, et le remplacement de l'exécutable — entier ou pas du
    //! tout, l'ancien remis si le nouveau ne se met pas en place.
    use super::{notes_excerpt, portable_target, previous_path, replace_executable, NOTES_MAX_CHARS};
    use std::fs;

    /// Un dossier jetable propre à chaque test.
    fn scratch(name: &str) -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("midgaard-update-{name}-{}-{nanos}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn la_cible_de_l_executable_unique_est_a_part_de_celle_du_bundle() {
        let target = portable_target();
        assert!(target.ends_with("-portable"), "{target}");
        // Les noms du plugin : `darwin`, `linux` ou `windows`, puis l'architecture.
        let os = if cfg!(target_os = "macos") { "darwin" } else if cfg!(windows) { "windows" } else { "linux" };
        assert!(target.starts_with(&format!("{os}-")), "{target}");
        assert_ne!(Some(target), tauri_plugin_updater::target());
    }

    #[test]
    fn les_notes_sont_du_texte_court_sans_caractere_de_controle() {
        assert_eq!(notes_excerpt(None), None);
        assert_eq!(notes_excerpt(Some("  \n ")), None);
        assert_eq!(notes_excerpt(Some("Corrige\u{1b}[2J l'invite\r\n- un\x07 point")).as_deref(), Some("Corrige[2J l'invite\n- un point"));
        let long = "é".repeat(NOTES_MAX_CHARS * 2);
        let cut = notes_excerpt(Some(&long)).unwrap();
        assert_eq!(cut.chars().count(), NOTES_MAX_CHARS + 1);
        assert!(cut.ends_with('…'));
    }

    #[test]
    fn l_executable_est_remplace_et_l_ancien_mis_de_cote() {
        let dir = scratch("remplace");
        let exe = dir.join("Midgaard-portable.exe");
        fs::write(&exe, b"ancien").unwrap();
        replace_executable(&exe, b"nouveau").unwrap();
        assert_eq!(fs::read(&exe).unwrap(), b"nouveau");
        assert_eq!(fs::read(previous_path(&exe)).unwrap(), b"ancien");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&exe).unwrap().permissions().mode() & 0o777, 0o755);
        }
        // Une seconde mise à jour passe par-dessus l'ancien mis de côté.
        replace_executable(&exe, b"suivant").unwrap();
        assert_eq!(fs::read(&exe).unwrap(), b"suivant");
        assert_eq!(fs::read(previous_path(&exe)).unwrap(), b"nouveau");
        // Rien d'autre ne traîne : ni fichier `.new`, ni copie.
        let mut left: Vec<_> = fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        left.sort();
        assert_eq!(left, vec!["Midgaard-portable.exe", "Midgaard-portable.exe.old"]);
    }

    #[test]
    fn un_remplacement_impossible_laisse_l_executable_en_place() {
        // Un exécutable absent : rien à déplacer. L'erreur le dit, et aucun
        // fichier `.new` ne reste derrière.
        let dir = scratch("absent");
        let exe = dir.join("Midgaard-portable");
        let err = replace_executable(&exe, b"nouveau").unwrap_err();
        assert!(err.contains("ne se déplace pas"), "{err}");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
        // Un dossier où l'on n'écrit pas : l'exécutable en place est intact.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let locked = scratch("verrou");
            let exe = locked.join("Midgaard-portable");
            fs::write(&exe, b"ancien").unwrap();
            fs::set_permissions(&locked, fs::Permissions::from_mode(0o555)).unwrap();
            let err = replace_executable(&exe, b"nouveau");
            fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
            assert!(err.unwrap_err().contains("écriture impossible"));
            assert_eq!(fs::read(&exe).unwrap(), b"ancien");
        }
    }
}
