//! Coque desktop de Midgaard (Slice 6, étape 7).
//!
//! Elle fait trois choses, et aucune autre :
//!
//!  1. **démarrer le daemon, ou s'y rattacher**, par la CLI du clone
//!     (`harness start`) — la même commande que dans un terminal, avec le
//!     même dossier runtime (`MIDGAARD_HOME`, sinon `~/.midgaard`) ;
//!  2. **lire l'adresse du dashboard** dans le fichier de découverte du daemon
//!     (`daemon.json`), qui dit le port réellement écouté — 7777, ou le port
//!     de repli si 7777 était pris ;
//!  3. **ouvrir une fenêtre sur cette adresse**, et nulle part ailleurs.
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

// Une application de fenêtre, sans console, une fois construite en release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};
use tauri::{Url, WebviewUrl, WebviewWindowBuilder};

/// Chemin de `node` : `MIDGAARD_NODE`, sinon celui qu'avait npm au build.
fn node_path() -> Option<String> {
    std::env::var("MIDGAARD_NODE")
        .ok()
        .filter(|p| !p.is_empty())
        .or_else(|| Some(env!("MIDGAARD_NODE_BUILD").to_owned()).filter(|p| !p.is_empty()))
}

/// Racine du clone : `MIDGAARD_REPO`, sinon celle du build.
fn repo_root() -> PathBuf {
    std::env::var("MIDGAARD_REPO")
        .ok()
        .filter(|p| !p.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("MIDGAARD_REPO_BUILD")))
}

/// Dossier runtime, comme `loadConfig` le calcule : `MIDGAARD_HOME`, sinon
/// `.midgaard` dans le dossier personnel.
fn runtime_home() -> Option<PathBuf> {
    if let Ok(home) = std::env::var("MIDGAARD_HOME") {
        if !home.is_empty() {
            return Some(PathBuf::from(home));
        }
    }
    let user = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).ok()?;
    Some(Path::new(&user).join(".midgaard"))
}

/// Démarre le daemon, ou s'y rattache, par la CLI du clone.
fn ensure_daemon(node: &str, repo: &Path) -> Result<(), String> {
    let cli = repo.join("packages").join("cli").join("src").join("main.ts");
    // `--conditions=midgaard-dev` : les paquets du workspace se résolvent vers
    // leurs sources, comme sous `npm run harness` — le clone n'a pas à être
    // compilé pour que la CLI tourne.
    let status = Command::new(node)
        .arg("--conditions=midgaard-dev")
        .arg(&cli)
        .arg("start")
        .current_dir(repo)
        .status()
        .map_err(|e| format!("impossible de lancer {node} : {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("le démarrage du daemon a échoué ({status}) : lancer `npm run harness -- start` dans {} pour voir pourquoi", repo.display()))
    }
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

fn main() -> ExitCode {
    let Some(node) = node_path() else {
        eprintln!("midgaard : chemin de node inconnu ; reconstruire par `npm run desktop:build`, ou définir MIDGAARD_NODE");
        return ExitCode::FAILURE;
    };
    let repo = repo_root();
    let Some(home) = runtime_home() else {
        eprintln!("midgaard : dossier personnel introuvable ; définir MIDGAARD_HOME");
        return ExitCode::FAILURE;
    };
    if let Err(e) = ensure_daemon(&node, &repo) {
        eprintln!("midgaard : {e}");
        return ExitCode::FAILURE;
    }
    let url = match dashboard_url(&home) {
        Ok(url) => url,
        Err(e) => {
            eprintln!("midgaard : {e}");
            return ExitCode::FAILURE;
        }
    };

    let allowed = url.origin();
    let result = tauri::Builder::default()
        .setup(move |app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.clone()))
                .title("Midgaard")
                .inner_size(1440.0, 900.0)
                .min_inner_size(900.0, 600.0)
                // Ni lien ni redirection ne mène ailleurs que sur le dashboard.
                // Un fichier déposé sur la fenêtre est intercepté par Tauri (son
                // gestionnaire par défaut, gardé exprès) : sans IPC, il n'a aucun
                // effet, et le webview ne tente pas de l'ouvrir.
                .on_navigation(move |target| target.origin() == allowed)
                .build()?;
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
    //! La seule logique de la coque qui protège : l'adresse lue dans le fichier
    //! de découverte. Un fichier modifié ne doit pas faire ouvrir une page
    //! distante dans une fenêtre qui ressemble au dashboard.
    use super::dashboard_url;
    use std::fs;

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
