//! Coque desktop de Midgaard.
//!
//! Elle fait trois choses, et aucune autre :
//!
//!  1. **démarrer le daemon, ou s'y rattacher**, par la CLI (`harness start`)
//!     — la même commande que dans un terminal, avec le même dossier runtime
//!     (`MIDGAARD_HOME`, sinon `~/.midgaard`) ;
//!  2. **lire l'adresse du dashboard** dans le fichier de découverte du daemon
//!     (`daemon.json`), qui dit le port réellement écouté — 7777, ou le port
//!     de repli si 7777 était pris ;
//!  3. **ouvrir une fenêtre sur cette adresse**, et nulle part ailleurs.
//!
//! Elle trouve la CLI de deux façons ([`Launch`]) :
//!
//!  - **application autonome** : le bundle embarque un Node, le harness
//!     compilé et le dashboard (`runtime/`, assemblé par
//!     `apps/desktop/scripts/stage.mjs`). Rien d'autre n'est requis sur la
//!     machine, ni Node ni clone ;
//!  - **exécutable unique** (`--features portable`) : le même arbre voyage
//!     **dans** le binaire, en archive, et se déplie au premier lancement
//!     dans le dossier de données de l'application ([`portable`]). Un seul
//!     fichier à copier et à lancer, sans installeur ;
//!  - **depuis un clone** (`npm run desktop`) : le Node et la racine du clone
//!     donnés par `MIDGAARD_NODE` et `MIDGAARD_REPO`, sinon ceux du build.
//!
//! Ce qu'elle ne fait pas, délibérément :
//!
//!  - **aucune capacité Tauri n'est accordée à la page** (`capabilities: []`) :
//!    le dashboard n'a pas d'IPC, il parle au daemon en HTTP comme dans un
//!    navigateur. La fenêtre charge `http://127.0.0.1:<port>/`, l'origine que
//!    le daemon accepte déjà : ses contrôles `Host`, `Origin` et
//!    `Sec-Fetch-Site` ne changent pas ;
//!  - **la fenêtre ne navigue que sur cette origine** : un lien ou une
//!    redirection vers ailleurs est refusé, et un fichier déposé sur la
//!    fenêtre est intercepté par Tauri, sans effet ;
//!  - **elle n'arrête pas le daemon** en se fermant : il s'arrête de lui-même
//!    après son délai d'inactivité, comme lorsqu'on ferme un onglet.
//!
//! Une panne au démarrage **se lit dans la fenêtre** : une application
//! ouverte d'un double-clic n'a pas de terminal, et une coque qui écrit sur
//! une sortie d'erreur que personne ne voit puis disparaît ressemble à une
//! application qui ne s'ouvre pas.

// Une application de fenêtre, sans console, une fois construite en release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};
use tauri::{Manager, Url, WebviewUrl, WebviewWindowBuilder};

/// Comment la coque lance la CLI.
#[derive(Debug, PartialEq)]
enum Launch {
    /// L'application autonome : tout est dans le bundle.
    Standalone {
        /// Le Node embarqué (`runtime/node`, `runtime/node.exe`).
        node: PathBuf,
        /// Le point d'entrée compilé de la CLI.
        cli: PathBuf,
        /// Le dashboard compilé, que le daemon servira.
        dashboard: PathBuf,
        /// Le script qui relance la CLI depuis un terminal (`bin/harness`).
        launcher: PathBuf,
    },
    /// Depuis un clone : la CLI tourne sur ses sources.
    Clone { node: String, repo: PathBuf },
}

/// Nom du Node embarqué sur cette plateforme.
const NODE_NAME: &str = if cfg!(windows) { "node.exe" } else { "node" };
/// Nom du lanceur embarqué sur cette plateforme.
const LAUNCHER_NAME: &str = if cfg!(windows) { "harness.cmd" } else { "harness" };

/// L'arbre embarqué sous le dossier de ressources, s'il y est **en entier**.
///
/// Un arbre partiel n'est pas une application autonome : mieux vaut retomber
/// sur le clone, ou dire ce qui manque, que lancer un Node sans CLI.
fn standalone_at(resources: &Path) -> Option<Launch> {
    let runtime = resources.join("runtime");
    let app = runtime.join("app");
    let launch = Launch::Standalone {
        node: runtime.join(NODE_NAME),
        cli: app.join("node_modules").join("@midgaard").join("cli").join("dist").join("main.js"),
        dashboard: app.join("dashboard"),
        launcher: app.join("bin").join(LAUNCHER_NAME),
    };
    let Launch::Standalone { node, cli, dashboard, launcher } = &launch else { return None };
    let complete = app.join("standalone.json").is_file()
        && node.is_file()
        && cli.is_file()
        && launcher.is_file()
        && dashboard.join("index.html").is_file();
    complete.then_some(launch)
}

/// Un chemin sans le préfixe `\\?\` de Windows : le dossier de ressources en
/// porte un, et la commande conseillée à l'utilisateur doit se coller telle
/// quelle dans cmd ou PowerShell.
fn plain(path: &Path) -> String {
    let text = path.display().to_string();
    text.strip_prefix(r"\\?\").map(str::to_owned).unwrap_or(text)
}

/// Valeur de `MIDGAARD_LAUNCHER` : le lanceur, entre guillemets, comme le
/// posent les scripts `harness` et `harness.cmd` eux-mêmes.
fn launcher_value(launcher: &Path) -> String {
    format!("\"{}\"", plain(launcher))
}

/// Chemin de `node` hors bundle : `MIDGAARD_NODE`, sinon celui qu'avait npm au build.
fn node_path() -> Option<String> {
    std::env::var("MIDGAARD_NODE")
        .ok()
        .filter(|p| !p.is_empty())
        .or_else(|| Some(env!("MIDGAARD_NODE_BUILD").to_owned()).filter(|p| !p.is_empty()))
}

/// Choisit comment lancer la CLI.
///
/// `MIDGAARD_REPO` passe devant tout : c'est `npm run desktop`, qui désigne
/// son clone. Sinon l'arbre embarqué, s'il est là ; sinon le clone du build.
fn choose_launch(resources: Option<&Path>) -> Result<Launch, String> {
    let env_repo = std::env::var("MIDGAARD_REPO").ok().filter(|p| !p.is_empty());
    if env_repo.is_none() {
        if let Some(standalone) = resources.and_then(standalone_at) {
            return Ok(standalone);
        }
    }
    let node = node_path().ok_or("chemin de node inconnu ; reconstruire par `npm run desktop:build`, ou définir MIDGAARD_NODE")?;
    let repo = env_repo.map(PathBuf::from).unwrap_or_else(|| PathBuf::from(env!("MIDGAARD_REPO_BUILD")));
    Ok(Launch::Clone { node, repo })
}

/// Dossier personnel de l'utilisateur.
fn user_home() -> Option<PathBuf> {
    std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).ok().filter(|p| !p.is_empty()).map(PathBuf::from)
}

/// Dossier runtime, comme `loadConfig` le calcule : `MIDGAARD_HOME`, sinon
/// `.midgaard` dans le dossier personnel.
fn runtime_home() -> Option<PathBuf> {
    if let Ok(home) = std::env::var("MIDGAARD_HOME") {
        if !home.is_empty() {
            return Some(PathBuf::from(home));
        }
    }
    Some(user_home()?.join(".midgaard"))
}

/// Le `PATH` du shell de connexion de l'utilisateur.
///
/// Une application ouverte d'un double-clic reçoit un `PATH` minimal
/// (`/usr/bin:/bin:…` sous macOS). Le daemon en hérite, et c'est par lui que
/// `exec` résout `git`, `npm` ou `python`, et la CLI le programme d'un serveur
/// MCP : sans le `PATH` du shell, un agent ne trouverait presque rien de ce
/// qu'un terminal trouve. On le demande donc au shell, une fois, avec un délai
/// — un profil qui attend une saisie ne doit pas bloquer l'ouverture.
#[cfg(unix)]
fn login_path() -> Option<String> {
    use std::process::Stdio;
    use std::time::{Duration, Instant};
    let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/sh".to_owned());
    // Des marqueurs autour de la valeur : un profil bavard écrit aussi sur la sortie.
    let mut child = Command::new(shell)
        .args(["-l", "-c", "printf '<<midgaard-path>>%s<<midgaard-path>>' \"$PATH\""])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let output = child.wait_with_output().ok()?;
    path_between_markers(&String::from_utf8_lossy(&output.stdout))
}

/// La valeur entre les deux marqueurs de [`login_path`], si elle n'est pas vide.
#[cfg_attr(not(unix), allow(dead_code))]
fn path_between_markers(output: &str) -> Option<String> {
    let mark = "<<midgaard-path>>";
    let start = output.find(mark)? + mark.len();
    let end = output[start..].find(mark)? + start;
    Some(output[start..end].to_owned()).filter(|p| !p.is_empty())
}

/// Démarre le daemon, ou s'y rattache, par la CLI.
fn ensure_daemon(launch: &Launch) -> Result<(), String> {
    let mut command = match launch {
        Launch::Standalone { node, cli, dashboard, launcher } => {
            let mut c = Command::new(node);
            c.arg(cli).arg("start");
            // Ce que posent aussi les scripts `harness` : le daemon sert le
            // dashboard embarqué, et conseille des commandes qui existent ici.
            c.env("MIDGAARD_DASHBOARD_DIR", dashboard);
            c.env("MIDGAARD_LAUNCHER", launcher_value(launcher));
            #[cfg(unix)]
            if let Some(path) = login_path() {
                c.env("PATH", path);
            }
            // Jamais le dossier du bundle comme dossier courant : le daemon en
            // hérite, et un bundle se remplace à la mise à jour.
            if let Some(home) = user_home() {
                c.current_dir(home);
            }
            c
        }
        Launch::Clone { node, repo } => {
            let cli = repo.join("packages").join("cli").join("src").join("main.ts");
            // `--conditions=midgaard-dev` : les paquets du workspace se résolvent
            // vers leurs sources, comme sous `npm run harness` — le clone n'a
            // pas à être compilé pour que la CLI tourne.
            let mut c = Command::new(node);
            c.arg("--conditions=midgaard-dev").arg(cli).arg("start").current_dir(repo);
            c
        }
    };
    // Sous Windows, un programme console lancé par une application de fenêtre
    // ouvre une console : `CREATE_NO_WINDOW` l'en empêche.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    // La sortie est gardée : c'est elle qui dit pourquoi le démarrage échoue,
    // et la fenêtre la montre.
    let output = command.output().map_err(|e| format!("impossible de lancer Node ({e})"))?;
    if output.status.success() {
        return Ok(());
    }
    let said = format!("{}{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    Err(format!("le démarrage du daemon a échoué ({}) :\n{}", output.status, said.trim()))
}

/// Adresse du dashboard, lue dans le fichier de découverte du daemon.
///
/// Seul `dashboard_url` est lu. Le fichier contient aussi le jeton d'API : il
/// n'est ni copié, ni passé à la fenêtre — le dashboard l'obtient lui-même par
/// `/ui/bootstrap`, comme dans un navigateur.
fn dashboard_url(home: &Path) -> Result<Url, String> {
    let file = home.join("daemon.json");
    let raw = std::fs::read_to_string(&file).map_err(|e| format!("{} illisible : {e}", file.display()))?;
    let value: serde_json::Value = serde_json::from_str(&raw).map_err(|e| format!("{} invalide : {e}", file.display()))?;
    let url = value
        .get("dashboard_url")
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("{} ne dit pas où est le dashboard", file.display()))?;
    let parsed = Url::parse(url).map_err(|e| format!("adresse du dashboard invalide ({url}) : {e}"))?;
    // La boucle locale, et rien d'autre : un fichier de découverte modifié ne
    // doit pas faire ouvrir une page distante dans cette fenêtre.
    match parsed.host_str() {
        Some("127.0.0.1") | Some("localhost") if parsed.scheme() == "http" => Ok(parsed),
        _ => Err(format!("adresse du dashboard refusée, hors de la boucle locale : {url}")),
    }
}

/// L'exécutable unique : l'arbre embarqué, archivé dans le binaire.
#[cfg(feature = "portable")]
mod portable {
    use std::path::{Path, PathBuf};

    /// L'archive `tar.gz` de `runtime/`, posée par `build.rs`.
    const ARCHIVE: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/runtime.tar.gz"));
    /// Empreinte de l'archive : le nom du dossier où elle se déplie.
    const STAMP: &str = env!("MIDGAARD_RUNTIME_STAMP");

    /// Déplie l'arbre embarqué s'il ne l'est pas déjà, et rend le dossier qui
    /// contient `runtime/`.
    pub fn ensure(data_dir: &Path) -> Result<PathBuf, String> {
        unpack_once(ARCHIVE, STAMP, &data_dir.join("portable"))
    }

    /// Déplie `archive` dans `base/<stamp>`, une fois.
    ///
    /// Le dépliage se fait **à côté**, puis le dossier est renommé : un
    /// dépliage interrompu (fenêtre fermée, machine éteinte) ne laisse jamais
    /// un arbre partiel sous le nom définitif, que le lancement suivant
    /// prendrait pour entier. Deux lancements simultanés déplient chacun de
    /// leur côté ; le second renommage échoue, et son auteur prend le dossier
    /// du premier.
    pub fn unpack_once(archive: &[u8], stamp: &str, base: &Path) -> Result<PathBuf, String> {
        let target = base.join(stamp);
        if target.join("runtime").is_dir() {
            return Ok(target);
        }
        let staging = base.join(format!("{stamp}.tmp-{}", std::process::id()));
        let fail = |what: &str, e: std::io::Error| format!("dépliage de l'application dans {} : {what} ({e})", base.display());
        let _ = std::fs::remove_dir_all(&staging);
        std::fs::create_dir_all(&staging).map_err(|e| fail("dossier non créé", e))?;
        // `unpack` refuse de lui-même une entrée qui sortirait du dossier, et
        // garde les droits d'exécution du Node et du lanceur.
        tar::Archive::new(flate2::read::GzDecoder::new(archive))
            .unpack(&staging)
            .map_err(|e| fail("archive illisible", e))?;
        match std::fs::rename(&staging, &target) {
            Ok(()) => Ok(target),
            Err(e) => {
                let _ = std::fs::remove_dir_all(&staging);
                if target.join("runtime").is_dir() {
                    Ok(target)
                } else {
                    Err(fail("renommage refusé", e))
                }
            }
        }
    }
}

/// Tout ce qui précède la fenêtre : choisir la CLI, démarrer le daemon, lire
/// l'adresse. Une seule erreur possible à montrer.
///
/// `data_dir` ne sert qu'à l'exécutable unique : c'est là qu'il se déplie.
#[cfg_attr(not(feature = "portable"), allow(unused_variables))]
fn prepare(resources: Option<&Path>, data_dir: Option<&Path>) -> Result<Url, String> {
    // L'exécutable unique n'a pas de dossier de ressources : son arbre est en
    // lui. Déplié, il se présente comme celui d'un bundle. `MIDGAARD_REPO`
    // garde la main, comme partout.
    #[cfg(feature = "portable")]
    let unpacked = match std::env::var("MIDGAARD_REPO").ok().filter(|p| !p.is_empty()) {
        Some(_) => None,
        None => Some(portable::ensure(data_dir.ok_or("dossier de données de l'application introuvable")?)?),
    };
    #[cfg(feature = "portable")]
    let resources = unpacked.as_deref().or(resources);
    let launch = choose_launch(resources)?;
    let home = runtime_home().ok_or("dossier personnel introuvable ; définir MIDGAARD_HOME")?;
    ensure_daemon(&launch)?;
    dashboard_url(&home)
}

fn main() -> ExitCode {
    let result = tauri::Builder::default()
        .setup(|app| {
            let resources = app.path().resource_dir().ok();
            let data_dir = app.path().app_local_data_dir().ok();
            match prepare(resources.as_deref(), data_dir.as_deref()) {
                Ok(url) => {
                    let allowed = url.origin();
                    WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                        .title("Midgaard")
                        .inner_size(1440.0, 900.0)
                        .min_inner_size(900.0, 600.0)
                        // Ni lien ni redirection ne mène ailleurs que sur le dashboard.
                        // Un fichier déposé sur la fenêtre est intercepté par Tauri (son
                        // gestionnaire par défaut, gardé exprès) : sans IPC, il n'a aucun
                        // effet, et le webview ne tente pas de l'ouvrir.
                        .on_navigation(move |target| target.origin() == allowed)
                        .build()?;
                }
                Err(message) => {
                    eprintln!("midgaard : {message}");
                    // La page embarquée (`ui/index.html`) affiche ce texte, comme
                    // du texte. `serde_json` l'écrit en littéral JavaScript : rien
                    // de ce que la CLI a imprimé ne peut sortir de la chaîne.
                    let literal = serde_json::to_string(&message).unwrap_or_else(|_| "\"\"".to_owned());
                    WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                        .title("Midgaard — démarrage impossible")
                        .inner_size(900.0, 520.0)
                        .initialization_script(format!("window.__MIDGAARD_ERROR__ = {literal};"))
                        // La page d'erreur ne mène nulle part : seule l'origine
                        // embarquée de Tauri est admise.
                        .on_navigation(|target| target.scheme() == "tauri" || target.host_str() == Some("tauri.localhost"))
                        .build()?;
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!());
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("midgaard : la fenêtre n'a pas pu s'ouvrir : {e}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    //! La logique de la coque qui protège : l'adresse lue dans le fichier de
    //! découverte — un fichier modifié ne doit pas faire ouvrir une page
    //! distante dans une fenêtre qui ressemble au dashboard — et le choix de
    //! l'arbre embarqué, qui ne vaut que s'il est entier.
    use super::{dashboard_url, launcher_value, path_between_markers, standalone_at, Launch, LAUNCHER_NAME, NODE_NAME};
    use std::fs;
    use std::path::Path;

    /// Pose un fichier vide, avec ses dossiers.
    fn touch(path: &Path) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, "").unwrap();
    }

    /// Un dossier de ressources jetable portant l'arbre embarqué, sauf `missing`.
    fn resources_without(missing: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("midgaard-desktop-res-{}-{}", std::process::id(), rand_suffix()));
        let node = format!("runtime/{NODE_NAME}");
        let launcher = format!("runtime/app/bin/{LAUNCHER_NAME}");
        for file in [
            node.as_str(),
            launcher.as_str(),
            "runtime/app/standalone.json",
            "runtime/app/node_modules/@midgaard/cli/dist/main.js",
            "runtime/app/dashboard/index.html",
        ] {
            if file != missing {
                touch(&dir.join(file));
            }
        }
        dir
    }

    #[test]
    fn l_arbre_embarque_ne_vaut_que_s_il_est_entier() {
        let whole = resources_without("");
        match standalone_at(&whole) {
            Some(Launch::Standalone { node, cli, dashboard, launcher }) => {
                assert_eq!(node, whole.join("runtime").join(NODE_NAME));
                assert!(cli.ends_with("main.js"));
                assert_eq!(dashboard, whole.join("runtime").join("app").join("dashboard"));
                assert!(launcher.ends_with(LAUNCHER_NAME));
            }
            other => panic!("arbre entier non reconnu : {other:?}"),
        }
        for missing in [
            "runtime/app/standalone.json",
            "runtime/app/node_modules/@midgaard/cli/dist/main.js",
            "runtime/app/dashboard/index.html",
        ] {
            assert_eq!(standalone_at(&resources_without(missing)), None, "arbre accepté sans {missing}");
        }
        // Un dossier de ressources sans arbre : la coque construite depuis un clone.
        assert_eq!(standalone_at(&std::env::temp_dir().join("midgaard-desktop-sans-arbre")), None);
    }

    #[test]
    fn le_lanceur_conseille_est_entre_guillemets_sans_prefixe_windows() {
        assert_eq!(launcher_value(Path::new("/Applications/Mid gaard.app/x/harness")), "\"/Applications/Mid gaard.app/x/harness\"");
        assert_eq!(launcher_value(Path::new(r"\\?\C:\Users\me\Midgaard\harness.cmd")), "\"C:\\Users\\me\\Midgaard\\harness.cmd\"");
    }

    /// L'exécutable unique : l'archive se déplie une fois, entière ou pas du tout.
    #[cfg(feature = "portable")]
    #[test]
    fn l_archive_se_deplie_une_fois_et_jamais_a_moitie() {
        use super::portable::unpack_once;
        // Une archive minimale : runtime/app/standalone.json.
        let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast()));
        let body = b"{}";
        let mut header = tar::Header::new_gnu();
        header.set_size(body.len() as u64);
        header.set_mode(0o755);
        header.set_cksum();
        builder.append_data(&mut header, "runtime/app/standalone.json", &body[..]).unwrap();
        let archive = builder.into_inner().unwrap().finish().unwrap();

        let base = std::env::temp_dir().join(format!("midgaard-portable-{}-{}", std::process::id(), rand_suffix()));
        let first = unpack_once(&archive, "abc-1", &base).unwrap();
        assert!(first.join("runtime/app/standalone.json").is_file());
        // Aucun dossier de dépliage ne traîne : seul le dossier définitif reste.
        let left: Vec<_> = fs::read_dir(&base).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(left, vec![std::ffi::OsString::from("abc-1")]);
        // Un second lancement ne redéplie pas : un fichier ajouté entre-temps survit.
        fs::write(first.join("temoin"), "x").unwrap();
        assert_eq!(unpack_once(&archive, "abc-1", &base).unwrap(), first);
        assert!(first.join("temoin").is_file());
        // Une autre version se déplie à côté, sans toucher à la première.
        let second = unpack_once(&archive, "def-2", &base).unwrap();
        assert_ne!(second, first);
        assert!(first.join("temoin").is_file());
        // Une archive corrompue ne laisse rien sous le nom définitif.
        assert!(unpack_once(b"pas une archive", "ghi-3", &base).is_err());
        assert!(!base.join("ghi-3").exists());
    }

    #[test]
    fn le_path_du_shell_se_lit_entre_ses_marqueurs() {
        let noisy = "bienvenue\n<<midgaard-path>>/opt/homebrew/bin:/usr/bin<<midgaard-path>>";
        assert_eq!(path_between_markers(noisy).as_deref(), Some("/opt/homebrew/bin:/usr/bin"));
        assert_eq!(path_between_markers("profil bavard, sans marqueur"), None);
        assert_eq!(path_between_markers("<<midgaard-path>><<midgaard-path>>"), None);
    }

    /// Un dossier runtime jetable, avec le `daemon.json` donné.
    fn home_with(json: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("midgaard-desktop-{}-{}", std::process::id(), rand_suffix()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("daemon.json"), json).unwrap();
        dir
    }

    /// Un suffixe propre à chaque test, pour qu'ils tournent en parallèle.
    fn rand_suffix() -> u128 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
    }

    #[test]
    fn lit_l_adresse_de_la_boucle_locale() {
        let home = home_with(r#"{"pid":1,"port":7790,"token":"secret","dashboard_url":"http://127.0.0.1:7790/"}"#);
        assert_eq!(dashboard_url(&home).unwrap().as_str(), "http://127.0.0.1:7790/");
        let home = home_with(r#"{"dashboard_url":"http://localhost:7777/"}"#);
        assert_eq!(dashboard_url(&home).unwrap().port(), Some(7777));
    }

    #[test]
    fn refuse_toute_adresse_hors_de_la_boucle_locale() {
        for url in [
            "http://exemple.org/",
            "https://127.0.0.1:7777/",
            "http://127.0.0.1.exemple.org/",
            "http://192.168.1.10:7777/",
            "file:///etc/passwd",
        ] {
            let home = home_with(&format!(r#"{{"dashboard_url":"{url}"}}"#));
            assert!(dashboard_url(&home).is_err(), "{url} accepté");
        }
    }

    #[test]
    fn dit_pourquoi_quand_le_fichier_manque_ou_ment() {
        let missing = std::env::temp_dir().join("midgaard-desktop-absent-de-test");
        assert!(dashboard_url(&missing).unwrap_err().contains("illisible"));
        let home = home_with(r#"{"port":7777}"#);
        assert!(dashboard_url(&home).unwrap_err().contains("ne dit pas où est le dashboard"));
    }
}
