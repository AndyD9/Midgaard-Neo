//! Script de build de la coque : prépare le contexte Tauri, et grave dans le
//! binaire de quoi démarrer le daemon sans rien hériter du shell.
//!
//! Une application lancée d'un double-clic (Finder, explorateur Windows)
//! **n'hérite pas du `PATH` du terminal** : elle ne trouverait pas `node`. Le
//! build se fait par `npm run desktop:build`, et npm donne le chemin exact de
//! son `node` dans `npm_node_execpath` : c'est lui qu'on retient, avec la
//! racine du clone, déduite de l'emplacement de ce fichier. Au lancement, les
//! variables `MIDGAARD_NODE` et `MIDGAARD_REPO` passent devant.

use std::path::PathBuf;

fn main() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    // apps/desktop/src-tauri → racine du clone.
    let repo = manifest
        .join("..")
        .join("..")
        .join("..")
        .canonicalize()
        .expect("racine du clone introuvable");
    println!("cargo:rustc-env=MIDGAARD_REPO_BUILD={}", plain(repo));

    let node = std::env::var("npm_node_execpath")
        .or_else(|_| std::env::var("NODE"))
        .unwrap_or_default();
    println!("cargo:rustc-env=MIDGAARD_NODE_BUILD={node}");
    println!("cargo:rerun-if-env-changed=npm_node_execpath");
    println!("cargo:rerun-if-env-changed=NODE");

    tauri_build::build()
}

/// Un chemin sans le préfixe `\\?\` que `canonicalize` ajoute sous Windows :
/// passé tel quel à `node`, il ne désigne pas le fichier attendu.
fn plain(path: PathBuf) -> String {
    let text = path.display().to_string();
    text.strip_prefix(r"\\?\").map(str::to_owned).unwrap_or(text)
}
